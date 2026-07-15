import { DurableObject } from "cloudflare:workers";
import type { BudgetLimits, ResolvedBreakerRules } from "./policy";
import {
  evaluateBreaker,
  HISTORY_WINDOW_MS,
  type BreakerSignal,
  type RequestSample,
} from "./breaker";
import {
  appendLedgerEvent,
  type LedgerAppend,
} from "./ledger";

// One instance per org (getByName(orgId)). Two jobs, both of which need
// per-org serialization that D1 can't provide:
//  1. Atomic budget counters — concurrent purchases must not race past a limit.
//  2. Ledger appends — concurrent writers would fork the hash chain.

export type ReserveArgs = {
  agentId: string;
  amountCents: number;
  orgLimits?: BudgetLimits;
  agentLimits?: BudgetLimits;
  /** Injectable clock for tests; defaults to now. */
  nowIso?: string;
};

export type ReserveResult =
  | { ok: true }
  | {
      ok: false;
      exceeded: "agent_daily" | "agent_monthly" | "org_daily" | "org_monthly";
      limitCents: number;
      usedCents: number;
    };

export type UsageSnapshot = {
  agentDailyCents: number;
  agentMonthlyCents: number;
  orgDailyCents: number;
  orgMonthlyCents: number;
};

export type BreakerCheckArgs = {
  agentId: string;
  vendor: string;
  amountCents: number;
  category: string;
  breakerRules: ResolvedBreakerRules;
  /** Injectable clock for tests; defaults to now. */
  nowIso?: string;
};

export type BreakerCheckResult =
  | { status: "ok" }
  | { status: "frozen"; reason: string; frozenAt: string }
  | { status: "tripped"; signal: BreakerSignal; reason: string };

export type FrozenAgentRow = {
  agent_id: string;
  frozen_at: string;
  signal: string;
  reason: string;
};

function periods(nowIso?: string): { day: string; month: string } {
  const day = (nowIso ?? new Date().toISOString()).slice(0, 10);
  return { day, month: day.slice(0, 7) };
}

export class OrgCoordinator extends DurableObject<Env> {
  // Serializes ledger appends: D1 writes cross an await, so without this two
  // concurrent RPCs could interleave and read the same chain tail.
  #ledgerTail: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS spend (
          period TEXT NOT NULL,
          scope TEXT NOT NULL,
          used_cents INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (period, scope)
        );
        CREATE TABLE IF NOT EXISTS agent_requests (
          agent_id TEXT NOT NULL,
          vendor TEXT NOT NULL,
          amount_cents INTEGER NOT NULL,
          category TEXT NOT NULL,
          at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_requests ON agent_requests(agent_id, at);
        CREATE TABLE IF NOT EXISTS agent_freezes (
          agent_id TEXT PRIMARY KEY,
          frozen_at TEXT NOT NULL,
          signal TEXT NOT NULL,
          reason TEXT NOT NULL
        );
      `);
    });
  }

  #used(period: string, scope: string): number {
    const rows = this.ctx.storage.sql
      .exec<{ used_cents: number }>(
        "SELECT used_cents FROM spend WHERE period = ? AND scope = ?",
        period,
        scope
      )
      .toArray();
    return rows[0]?.used_cents ?? 0;
  }

  #add(period: string, scope: string, deltaCents: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO spend (period, scope, used_cents) VALUES (?, ?, ?)
       ON CONFLICT (period, scope) DO UPDATE SET used_cents = used_cents + excluded.used_cents`,
      period,
      scope,
      deltaCents
    );
  }

  // Fully synchronous (SQL storage ops don't yield), so each call is atomic
  // with respect to other DO events.
  reserve(args: ReserveArgs): ReserveResult {
    const { day, month } = periods(args.nowIso);
    const agentScope = `agent:${args.agentId}`;

    const checks: Array<{
      exceeded: Exclude<ReserveResult, { ok: true }>["exceeded"];
      limit: number | undefined;
      used: number;
    }> = [
      {
        exceeded: "agent_daily",
        limit: args.agentLimits?.dailyCents,
        used: this.#used(day, agentScope),
      },
      {
        exceeded: "agent_monthly",
        limit: args.agentLimits?.monthlyCents,
        used: this.#used(month, agentScope),
      },
      {
        exceeded: "org_daily",
        limit: args.orgLimits?.dailyCents,
        used: this.#used(day, "org"),
      },
      {
        exceeded: "org_monthly",
        limit: args.orgLimits?.monthlyCents,
        used: this.#used(month, "org"),
      },
    ];

    for (const check of checks) {
      if (check.limit !== undefined && check.used + args.amountCents > check.limit) {
        return {
          ok: false,
          exceeded: check.exceeded,
          limitCents: check.limit,
          usedCents: check.used,
        };
      }
    }

    this.#add(day, agentScope, args.amountCents);
    this.#add(month, agentScope, args.amountCents);
    this.#add(day, "org", args.amountCents);
    this.#add(month, "org", args.amountCents);
    return { ok: true };
  }

  // Unchecked counter adjustment: outcome corrections (final charge differed
  // from the approved amount) and releases (approved but never executed).
  adjust(args: { agentId: string; deltaCents: number; nowIso?: string }): void {
    const { day, month } = periods(args.nowIso);
    const agentScope = `agent:${args.agentId}`;
    this.#add(day, agentScope, args.deltaCents);
    this.#add(month, agentScope, args.deltaCents);
    this.#add(day, "org", args.deltaCents);
    this.#add(month, "org", args.deltaCents);
  }

  usage(args: { agentId: string; nowIso?: string }): UsageSnapshot {
    const { day, month } = periods(args.nowIso);
    const agentScope = `agent:${args.agentId}`;
    return {
      agentDailyCents: this.#used(day, agentScope),
      agentMonthlyCents: this.#used(month, agentScope),
      orgDailyCents: this.#used(day, "org"),
      orgMonthlyCents: this.#used(month, "org"),
    };
  }

  // Circuit breaker: log every purchase request (approved or not — a loop of
  // denials is still a loop), evaluate the pattern, and freeze the agent on a
  // trip. Synchronous like reserve(), so each call is atomic per org.
  recordAndCheck(args: BreakerCheckArgs): BreakerCheckResult {
    const frozen = this.#freezeRow(args.agentId);
    if (frozen) {
      return { status: "frozen", reason: frozen.reason, frozenAt: frozen.frozen_at };
    }

    const nowIso = args.nowIso ?? new Date().toISOString();
    const cutoff = new Date(Date.parse(nowIso) - HISTORY_WINDOW_MS).toISOString();
    this.ctx.storage.sql.exec("DELETE FROM agent_requests WHERE at < ?", cutoff);

    const history: RequestSample[] = this.ctx.storage.sql
      .exec<{ vendor: string; amount_cents: number; category: string; at: string }>(
        "SELECT vendor, amount_cents, category, at FROM agent_requests WHERE agent_id = ? AND at >= ?",
        args.agentId,
        cutoff
      )
      .toArray()
      .map((r) => ({
        vendor: r.vendor,
        amountCents: r.amount_cents,
        category: r.category,
        atIso: r.at,
      }));
    const current: RequestSample = {
      vendor: args.vendor,
      amountCents: args.amountCents,
      category: args.category,
      atIso: nowIso,
    };

    this.ctx.storage.sql.exec(
      "INSERT INTO agent_requests (agent_id, vendor, amount_cents, category, at) VALUES (?, ?, ?, ?, ?)",
      args.agentId,
      args.vendor,
      args.amountCents,
      args.category,
      nowIso
    );

    const verdict = evaluateBreaker(args.breakerRules, history, current);
    if (!verdict.tripped) return { status: "ok" };

    this.ctx.storage.sql.exec(
      "INSERT INTO agent_freezes (agent_id, frozen_at, signal, reason) VALUES (?, ?, ?, ?)",
      args.agentId,
      nowIso,
      verdict.signal,
      verdict.reason
    );
    return { status: "tripped", signal: verdict.signal, reason: verdict.reason };
  }

  #freezeRow(agentId: string): FrozenAgentRow | undefined {
    return this.ctx.storage.sql
      .exec<FrozenAgentRow>(
        "SELECT agent_id, frozen_at, signal, reason FROM agent_freezes WHERE agent_id = ?",
        agentId
      )
      .toArray()[0];
  }

  isFrozen(args: { agentId: string }): { frozen: boolean; reason?: string } {
    const row = this.#freezeRow(args.agentId);
    return row ? { frozen: true, reason: row.reason } : { frozen: false };
  }

  unfreeze(args: { agentId: string }): { ok: boolean } {
    const existed = this.#freezeRow(args.agentId) !== undefined;
    this.ctx.storage.sql.exec(
      "DELETE FROM agent_freezes WHERE agent_id = ?",
      args.agentId
    );
    return { ok: existed };
  }

  frozenAgents(): FrozenAgentRow[] {
    return this.ctx.storage.sql
      .exec<FrozenAgentRow>(
        "SELECT agent_id, frozen_at, signal, reason FROM agent_freezes ORDER BY frozen_at DESC"
      )
      .toArray();
  }

  appendEvent(event: LedgerAppend): Promise<{ seq: number; hash: string }> {
    const next = this.#ledgerTail.then(() =>
      appendLedgerEvent(this.env.DB, event)
    );
    this.#ledgerTail = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}
