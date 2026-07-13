import { DurableObject } from "cloudflare:workers";
import type { BudgetLimits } from "./policy";
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
        )
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
