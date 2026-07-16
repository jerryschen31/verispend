import { Hono, type MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Child } from "hono/jsx";
import { decideRequestById } from "./approvals";
import {
  MEMBER_ROLES,
  countAdmins,
  createAgentKey,
  deleteMember,
  getActivePolicy,
  getFirstMembershipByEmail,
  getMemberById,
  getLatestReceipt,
  getMandateForRequest,
  getMembership,
  getOrg,
  getOrgByApproverEmail,
  insertMandateIssuer,
  insertPolicy,
  createTeam,
  getPurchaseRequest,
  getTeam,
  listAgentKeys,
  listLedgerEventsForRequest,
  listBilledCharges,
  listKnownAgentIds,
  listMandateIssuers,
  listMembers,
  listPurchaseRequests,
  listSettlements,
  listSettlementsForRequest,
  listTeamAgents,
  listTeamApprovers,
  listTeams,
  listUsageRecords,
  revokeAgentKey,
  revokeMandateIssuer,
  setAgentTeam,
  setTeamApprover,
  upsertMember,
  type MemberRole,
  type PurchaseRequestRow,
  type RequestStatus,
} from "./db";
import { resolveTeamLimits } from "./policy";
import { ingestBill } from "./reconcile";
import { ingestSettlement, SETTLEMENT_RAILS } from "./settlements";
import { issueReceipt } from "./receipts";
import { MANDATE_ALGS, MANDATE_SCHEMES } from "./mandate";
import { verifyLedgerChain } from "./ledger";
import {
  EXPORT_ROW_LIMIT,
  buildAuditBundle,
  exportBillsCsv,
  exportLedgerEventsCsv,
  exportPurchasesCsv,
  exportSettlementsCsv,
  exportUsageCsv,
} from "./export";
import type { FrozenAgentRow } from "./org-do";
import type { PolicyRules } from "./policy";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  signToken,
  verifyToken,
} from "./session";
import {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_SECONDS,
  authorizeUrl,
  exchangeCodeForEmail,
  logoutUrl,
} from "./kinde";

type Vars = { orgId: string; email: string; role: MemberRole };

export const dashboard = new Hono<{ Bindings: Env; Variables: Vars }>();

const fmt = (cents: number, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    cents / 100
  );

const STATUS_COLORS: Record<RequestStatus, string> = {
  approved: "#16a34a",
  completed: "#0d9488",
  pending_approval: "#d97706",
  denied: "#dc2626",
  canceled: "#6b7280",
};

const Layout = (props: { title: string; orgName?: string; children: Child }) => (
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{props.title} — VeriSpend</title>
      <style>{`
        body { font-family: system-ui, sans-serif; margin: 0; color: #111; }
        header { background: #0f172a; color: #fff; padding: 0.8rem 1.5rem; display: flex; gap: 1.5rem; align-items: baseline; }
        header a { color: #cbd5e1; text-decoration: none; font-size: 0.95rem; }
        header a:hover { color: #fff; }
        header .brand { color: #fff; font-weight: 700; font-size: 1.1rem; }
        main { max-width: 64rem; margin: 1.5rem auto; padding: 0 1.5rem; }
        table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
        th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid #e5e7eb; }
        th { color: #6b7280; font-weight: 600; }
        .pill { border-radius: 999px; padding: 0.15rem 0.6rem; color: #fff; font-size: 0.8rem; white-space: nowrap; }
        .btn { border: none; border-radius: 6px; padding: 0.4rem 0.9rem; cursor: pointer; color: #fff; font-size: 0.85rem; }
        .muted { color: #6b7280; font-size: 0.85rem; }
        input, textarea, select { font: inherit; padding: 0.4rem; border: 1px solid #d1d5db; border-radius: 6px; }
        textarea { width: 100%; font-family: ui-monospace, monospace; }
        code { background: #f1f5f9; padding: 0.1rem 0.3rem; border-radius: 4px; }
      `}</style>
    </head>
    <body>
      <header>
        <span class="brand">VeriSpend</span>
        <a href="/dashboard">Approvals</a>
        <a href="/dashboard/ledger">Ledger</a>
        <a href="/dashboard/reconciliation">Reconciliation</a>
        <a href="/dashboard/settlements">Settlements</a>
        <a href="/dashboard/policy">Policy</a>
        <a href="/dashboard/issuers">Issuers</a>
        <a href="/dashboard/keys">Agent Keys</a>
        <a href="/dashboard/teams">Teams</a>
        <a href="/dashboard/members">Members</a>
        <a href="/dashboard/export">Export</a>
        <a href="/dashboard/audit">Audit</a>
        <span style="flex:1" />
        {props.orgName && <span class="muted">{props.orgName}</span>}
        <a href="/auth/logout">Log out</a>
      </header>
      <main>{props.children}</main>
    </body>
  </html>
);

const StatusPill = ({ status }: { status: RequestStatus }) => (
  <span class="pill" style={`background:${STATUS_COLORS[status]}`}>
    {status.replaceAll("_", " ")}
  </span>
);

const RequestTable = (props: {
  rows: PurchaseRequestRow[];
  actions?: boolean;
}) => (
  <table>
    <tr>
      <th>When (UTC)</th>
      <th>Agent</th>
      <th>Vendor</th>
      <th>Amount</th>
      <th>Category</th>
      <th>Status</th>
      <th>Rule</th>
      {props.actions && <th />}
    </tr>
    {props.rows.map((r) => (
      <tr>
        <td>
          <a href={`/dashboard/requests/${r.id}`}>
            {r.created_at.slice(0, 16).replace("T", " ")}
          </a>
        </td>
        <td>{r.agent_id}</td>
        <td>
          {r.vendor}
          <div class="muted">{r.justification}</div>
        </td>
        <td>
          {fmt(r.amount_cents, r.currency)}
          {r.outcome_amount_cents !== null &&
            r.outcome_amount_cents !== r.amount_cents && (
              <div class="muted">final {fmt(r.outcome_amount_cents, r.currency)}</div>
            )}
        </td>
        <td>{r.category}</td>
        <td>
          <StatusPill status={r.status} />
          {r.denial_reason && <div class="muted">{r.denial_reason}</div>}
        </td>
        <td class="muted">{r.rule_fired}</td>
        {props.actions && (
          <td style="white-space:nowrap">
            <form method="post" action="/dashboard/decide" style="display:inline">
              <input type="hidden" name="request_id" value={r.id} />
              <button class="btn" style="background:#16a34a" name="action" value="approve">
                Approve
              </button>{" "}
              <button class="btn" style="background:#dc2626" name="action" value="deny">
                Deny
              </button>
            </form>
          </td>
        )}
      </tr>
    ))}
  </table>
);

// ---------- Auth (Kinde OIDC) ----------

dashboard.get("/login", (c) =>
  c.html(
    <html>
      <head>
        <title>Log in — VeriSpend</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body style="font-family:system-ui;max-width:24rem;margin:5rem auto;padding:0 1rem">
        <h1>VeriSpend</h1>
        <p>Verified spend for AI agents. Sign in with your approver account.</p>
        <a
          href="/auth/login"
          style="display:inline-block;background:#0f172a;margin-top:0.8rem;padding:0.6rem 1.2rem;color:#fff;border-radius:6px;text-decoration:none"
        >
          Sign in
        </a>
      </body>
    </html>
  )
);

dashboard.get("/auth/login", (c) => {
  const state = crypto.randomUUID();
  setCookie(c, OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: c.env.BASE_URL.startsWith("https://"),
    sameSite: "Lax",
    path: "/",
    maxAge: OAUTH_STATE_TTL_SECONDS,
  });
  return c.redirect(authorizeUrl(c.env, state));
});

dashboard.get("/auth/callback", async (c) => {
  const state = c.req.query("state") ?? "";
  const code = c.req.query("code") ?? "";
  const expectedState = getCookie(c, OAUTH_STATE_COOKIE);
  deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/" });
  if (!code || !state || state !== expectedState) {
    return c.text("Sign-in failed: state mismatch. Please try again.", 401);
  }

  const result = await exchangeCodeForEmail(c.env, code);
  if ("error" in result) {
    console.log(JSON.stringify({ event: "kinde_exchange_failed", error: result.error }));
    return c.text("Sign-in failed. Please try again.", 401);
  }

  let membership = await getFirstMembershipByEmail(c.env.DB, result.email);
  if (!membership) {
    // One-release safety net for orgs created between code deploy and the
    // 0004 migration seed: promote a legacy approver_email to admin member.
    const legacyOrg = await getOrgByApproverEmail(c.env.DB, result.email);
    if (legacyOrg) {
      await upsertMember(c.env.DB, {
        orgId: legacyOrg.id,
        email: result.email,
        role: "admin",
      });
      membership = await getMembership(c.env.DB, legacyOrg.id, result.email);
    }
  }
  if (!membership) {
    return c.html(
      <body style="font-family:system-ui;max-width:28rem;margin:5rem auto">
        <h1>No org for this account</h1>
        <p>
          You signed in as <strong>{result.email}</strong>, but that address is
          not a member of any VeriSpend org.
        </p>
        <a href={logoutUrl(c.env)}>Sign in with a different account</a>
      </body>,
      403
    );
  }

  const session = await signToken(c.env.SESSION_SECRET, {
    purpose: "session",
    email: membership.email,
    orgId: membership.org_id,
    exp: Date.now() + SESSION_TTL_MS,
  });
  setCookie(c, SESSION_COOKIE, session, {
    httpOnly: true,
    secure: c.env.BASE_URL.startsWith("https://"),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  return c.redirect("/dashboard");
});

dashboard.get("/auth/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.redirect(logoutUrl(c.env));
});

// ---------- Session middleware ----------

const requireSession: MiddlewareHandler<{
  Bindings: Env;
  Variables: Vars;
}> = async (c, next) => {
  const cookie = getCookie(c, SESSION_COOKIE);
  const payload = cookie
    ? await verifyToken(c.env.SESSION_SECRET, cookie, "session")
    : null;
  if (!payload) return c.redirect("/login");
  // Role is looked up per request (not stored in the token) so removing or
  // downgrading a member takes effect immediately.
  const membership = await getMembership(c.env.DB, payload.orgId, payload.email);
  if (!membership) {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.redirect("/login");
  }
  c.set("orgId", payload.orgId);
  c.set("email", payload.email);
  c.set("role", membership.role);
  await next();
};
dashboard.use("/dashboard", requireSession);
dashboard.use("/dashboard/*", requireSession);

const requireRole =
  (...roles: MemberRole[]): MiddlewareHandler<{ Bindings: Env; Variables: Vars }> =>
  async (c, next) => {
    if (!roles.includes(c.get("role"))) {
      return c.text(`Forbidden: requires ${roles.join(" or ")} role.`, 403);
    }
    await next();
  };
const adminOnly = requireRole("admin");
const canDecide = requireRole("admin", "approver");

dashboard.use("/dashboard/decide", canDecide);
dashboard.use("/dashboard/bills", canDecide);
dashboard.use("/dashboard/policy", async (c, next) =>
  c.req.method === "POST" ? adminOnly(c, next) : next()
);
dashboard.use("/dashboard/keys/create", adminOnly);
dashboard.use("/dashboard/keys/revoke", adminOnly);
dashboard.use("/dashboard/agents/unfreeze", adminOnly);
const adminPosts: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = (
  c,
  next
) => (c.req.method === "POST" ? adminOnly(c, next) : next());
dashboard.use("/dashboard/members", adminPosts);
dashboard.use("/dashboard/members/delete", adminOnly);
dashboard.use("/dashboard/teams", adminPosts);
dashboard.use("/dashboard/teams/*", adminPosts);
const decidePosts: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = (
  c,
  next
) => (c.req.method === "POST" ? canDecide(c, next) : next());
dashboard.use("/dashboard/settlements", decidePosts);
dashboard.use("/dashboard/issuers", adminPosts);
dashboard.use("/dashboard/issuers/revoke", adminOnly);
dashboard.use("/dashboard/requests/:id/receipt", canDecide);

// ---------- Views ----------

const FrozenBanner = ({ frozen }: { frozen: FrozenAgentRow[] }) =>
  frozen.length === 0 ? null : (
    <div style="background:#fef2f2;border:1px solid #dc2626;border-radius:8px;padding:0.8rem 1rem;margin-bottom:1.2rem">
      <strong style="color:#dc2626">
        Circuit breaker: {frozen.length} frozen agent{frozen.length > 1 ? "s" : ""}
      </strong>
      {frozen.map((f) => (
        <div class="muted" style="margin-top:0.3rem">
          <code>{f.agent_id}</code> — {f.reason}{" "}
          <a href="/dashboard/keys">Review</a>
        </div>
      ))}
    </div>
  );

dashboard.get("/dashboard", async (c) => {
  const orgId = c.get("orgId");
  const org = await getOrg(c.env.DB, orgId);
  const frozen = await c.env.ORG.getByName(orgId).frozenAgents();
  const pending = await listPurchaseRequests(c.env.DB, orgId, {
    status: "pending_approval",
  });
  const recent = await listPurchaseRequests(c.env.DB, orgId, {
    limit: 15,
  });

  return c.html(
    <Layout title="Approvals" orgName={org?.name}>
      <FrozenBanner frozen={frozen} />
      <h2>Pending approvals ({pending.length})</h2>
      {pending.length === 0 ? (
        <p class="muted">Nothing waiting on you.</p>
      ) : (
        <RequestTable rows={pending} actions={c.get("role") !== "viewer"} />
      )}
      <h2>Recent activity</h2>
      <RequestTable rows={recent} />
    </Layout>
  );
});

dashboard.post("/dashboard/decide", async (c) => {
  const form = await c.req.formData();
  const requestId = String(form.get("request_id") ?? "");
  const action = String(form.get("action") ?? "");
  if (action === "approve" || action === "deny") {
    await decideRequestById(c.env, c.get("orgId"), requestId, action, {
      approver: c.get("email"),
      via: "dashboard",
    });
  }
  return c.redirect("/dashboard");
});

dashboard.get("/dashboard/ledger", async (c) => {
  const org = await getOrg(c.env.DB, c.get("orgId"));
  const status = c.req.query("status") as RequestStatus | undefined;
  const agentId = c.req.query("agent") || undefined;
  const rows = await listPurchaseRequests(c.env.DB, c.get("orgId"), {
    status: status || undefined,
    agentId,
    limit: 200,
  });
  return c.html(
    <Layout title="Ledger" orgName={org?.name}>
      <h2>Purchase ledger</h2>
      <form method="get" style="margin-bottom:1rem;display:flex;gap:0.5rem">
        <select name="status">
          <option value="">All statuses</option>
          {(["approved", "completed", "pending_approval", "denied"] as const).map(
            (s) => (
              <option value={s} selected={s === status}>
                {s.replaceAll("_", " ")}
              </option>
            )
          )}
        </select>
        <input name="agent" placeholder="Agent id" value={agentId ?? ""} />
        <button class="btn" style="background:#0f172a">Filter</button>
        <span style="flex:1" />
        <a href="/dashboard/ledger.csv">Export CSV</a>
      </form>
      <RequestTable rows={rows} />
    </Layout>
  );
});

// Legacy export URL; the filtered exports live under /dashboard/export.
dashboard.get("/dashboard/ledger.csv", (c) =>
  c.redirect("/dashboard/export/purchases.csv")
);

// ---------- Exports ----------

const csvHeaders = (filename: string) => ({
  "content-type": "text/csv; charset=utf-8",
  "content-disposition": `attachment; filename="${filename}"`,
});

const exportFilters = (c: {
  req: { query: (k: string) => string | undefined };
}) => ({
  from: c.req.query("from") || undefined,
  to: c.req.query("to") || undefined,
  agentId: c.req.query("agent") || undefined,
  status: c.req.query("status") || undefined,
  teamId: c.req.query("team") || undefined,
  vendor: c.req.query("vendor") || undefined,
  eventType: c.req.query("type") || undefined,
  rail: c.req.query("rail") || undefined,
  matchStatus: c.req.query("match") || undefined,
});

dashboard.get("/dashboard/export", async (c) => {
  const orgId = c.get("orgId");
  const org = await getOrg(c.env.DB, orgId);
  const teams = await listTeams(c.env.DB, orgId);
  return c.html(
    <Layout title="Export" orgName={org?.name}>
      <h2>Audit exports</h2>
      <p class="muted">
        Filtered CSV exports of every record type (capped at{" "}
        {EXPORT_ROW_LIMIT.toLocaleString()} rows), plus a self-verifiable JSON
        audit bundle carrying the full hash chain and the recipe to re-verify
        it without VeriSpend.
      </p>
      <form method="get" action="/dashboard/export/purchases.csv" style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:1rem">
        <label>From <input name="from" type="date" /></label>
        <label>To <input name="to" type="date" /></label>
        <input name="agent" placeholder="Agent id" />
        <select name="status">
          <option value="">All statuses</option>
          {(["approved", "completed", "pending_approval", "denied"] as const).map((s) => (
            <option value={s}>{s.replaceAll("_", " ")}</option>
          ))}
        </select>
        <select name="team">
          <option value="">All teams</option>
          {teams.map((t) => (
            <option value={t.id}>{t.name}</option>
          ))}
        </select>
        <button class="btn" style="background:#0f172a">Purchases CSV</button>
      </form>
      <ul>
        <li>
          <a href="/dashboard/export/purchases.csv">purchases.csv</a>{" "}
          <span class="muted">— filters: from, to, agent, status, team</span>
        </li>
        <li>
          <a href="/dashboard/export/ledger-events.csv">ledger-events.csv</a>{" "}
          <span class="muted">— the hash chain itself; filters: from, to, type</span>
        </li>
        <li>
          <a href="/dashboard/export/usage.csv">usage.csv</a>{" "}
          <span class="muted">— metered usage; filters: from, to, agent, vendor</span>
        </li>
        <li>
          <a href="/dashboard/export/bills.csv">bills.csv</a>{" "}
          <span class="muted">— reconciled bills; filters: from, to, vendor</span>
        </li>
        <li>
          <a href="/dashboard/export/settlements.csv">settlements.csv</a>{" "}
          <span class="muted">
            — cross-rail settlement matches; filters: from, to, rail, match
          </span>
        </li>
        <li>
          <a href="/dashboard/export/audit-bundle.json">audit-bundle.json</a>{" "}
          <span class="muted">
            — full chain + verification + policies; always unfiltered so it
            can self-verify
          </span>
        </li>
      </ul>
    </Layout>
  );
});

dashboard.get("/dashboard/export/purchases.csv", async (c) => {
  const csv = await exportPurchasesCsv(c.env.DB, c.get("orgId"), exportFilters(c));
  return c.body(csv, 200, csvHeaders("verispend-purchases.csv"));
});

dashboard.get("/dashboard/export/ledger-events.csv", async (c) => {
  const csv = await exportLedgerEventsCsv(c.env.DB, c.get("orgId"), exportFilters(c));
  return c.body(csv, 200, csvHeaders("verispend-ledger-events.csv"));
});

dashboard.get("/dashboard/export/usage.csv", async (c) => {
  const csv = await exportUsageCsv(c.env.DB, c.get("orgId"), exportFilters(c));
  return c.body(csv, 200, csvHeaders("verispend-usage.csv"));
});

dashboard.get("/dashboard/export/bills.csv", async (c) => {
  const csv = await exportBillsCsv(c.env.DB, c.get("orgId"), exportFilters(c));
  return c.body(csv, 200, csvHeaders("verispend-bills.csv"));
});

dashboard.get("/dashboard/export/settlements.csv", async (c) => {
  const csv = await exportSettlementsCsv(c.env.DB, c.get("orgId"), exportFilters(c));
  return c.body(csv, 200, csvHeaders("verispend-settlements.csv"));
});

dashboard.get("/dashboard/export/audit-bundle.json", async (c) => {
  const bundle = await buildAuditBundle(c.env.DB, c.get("orgId"));
  return c.body(JSON.stringify(bundle, null, 2), 200, {
    "content-type": "application/json",
    "content-disposition": 'attachment; filename="verispend-audit-bundle.json"',
  });
});

const RECON_COLORS: Record<string, string> = {
  ok: "#16a34a",
  overbilled: "#dc2626",
  underbilled: "#d97706",
  no_usage_data: "#d97706",
};

dashboard.get("/dashboard/reconciliation", async (c) => {
  const orgId = c.get("orgId");
  const org = await getOrg(c.env.DB, orgId);
  const bills = await listBilledCharges(c.env.DB, orgId);
  const usage = await listUsageRecords(c.env.DB, orgId, 25);
  const error = c.req.query("error");

  return c.html(
    <Layout title="Reconciliation" orgName={org?.name}>
      <h2>Enter a provider bill</h2>
      <p class="muted">
        VeriSpend compares the billed amount against what your agents reported
        consuming (via <code>record_usage</code>) in the same period, and flags
        over-charges.
      </p>
      {error && <p style="color:#dc2626">{error}</p>}
      <form method="post" action="/dashboard/bills" style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:1.5rem">
        <input name="vendor" placeholder="Vendor, e.g. OpenAI" required />
        <input name="period_start" type="date" required />
        <input name="period_end" type="date" required />
        <input name="amount_cents" type="number" min="1" placeholder="Amount (cents)" required />
        <input name="memo" placeholder="Memo (optional)" />
        <button class="btn" style="background:#0f172a">Reconcile</button>
      </form>

      <h2>Bills</h2>
      {bills.length === 0 ? (
        <p class="muted">No bills entered yet.</p>
      ) : (
        <table>
          <tr>
            <th>Entered (UTC)</th>
            <th>Vendor</th>
            <th>Period</th>
            <th>Billed</th>
            <th>Expected</th>
            <th>Variance</th>
            <th>Status</th>
          </tr>
          {bills.map((b) => (
            <tr>
              <td>{b.created_at.slice(0, 16).replace("T", " ")}</td>
              <td>
                {b.vendor}
                {b.memo && <div class="muted">{b.memo}</div>}
              </td>
              <td>
                {b.period_start} → {b.period_end}
              </td>
              <td>{fmt(b.amount_cents)}</td>
              <td>{fmt(b.expected_cents)}</td>
              <td style={b.variance_cents > 0 ? "color:#dc2626" : undefined}>
                {b.variance_cents >= 0 ? "+" : ""}
                {fmt(b.variance_cents)}
              </td>
              <td>
                <span
                  class="pill"
                  style={`background:${RECON_COLORS[b.recon_status] ?? "#6b7280"}`}
                >
                  {b.recon_status.replaceAll("_", " ")}
                </span>
              </td>
            </tr>
          ))}
        </table>
      )}

      <h2>Recent usage reports</h2>
      {usage.length === 0 ? (
        <p class="muted">
          No usage recorded yet. Agents report metered consumption with the{" "}
          <code>record_usage</code> tool.
        </p>
      ) : (
        <table>
          <tr>
            <th>When (UTC)</th>
            <th>Agent</th>
            <th>Vendor</th>
            <th>Metric</th>
            <th>Units</th>
            <th>Expected cost</th>
          </tr>
          {usage.map((u) => (
            <tr>
              <td>{u.created_at.slice(0, 16).replace("T", " ")}</td>
              <td>{u.agent_id}</td>
              <td>
                {u.vendor}
                {u.note && <div class="muted">{u.note}</div>}
              </td>
              <td>{u.metric}</td>
              <td>{u.units}</td>
              <td>{fmt(u.expected_cost_cents)}</td>
            </tr>
          ))}
        </table>
      )}
    </Layout>
  );
});

dashboard.post("/dashboard/bills", async (c) => {
  const form = await c.req.formData();
  const result = await ingestBill(c.env, {
    orgId: c.get("orgId"),
    vendor: String(form.get("vendor") ?? ""),
    periodStart: String(form.get("period_start") ?? ""),
    periodEnd: String(form.get("period_end") ?? ""),
    amountCents: Number(form.get("amount_cents")),
    memo: String(form.get("memo") ?? "") || undefined,
    enteredBy: c.get("email"),
  });
  if (!result.ok) {
    return c.redirect(
      `/dashboard/reconciliation?error=${encodeURIComponent(result.error)}`
    );
  }
  return c.redirect("/dashboard/reconciliation");
});

// ---------- Settlements (Phase 3: cross-rail charge confirmations) ----------

const MATCH_COLORS: Record<string, string> = {
  matched: "#16a34a",
  amount_mismatch: "#d97706",
  unauthorized: "#dc2626",
};

const MatchPill = ({ status }: { status: string }) => (
  <span class="pill" style={`background:${MATCH_COLORS[status] ?? "#6b7280"}`}>
    {status.replaceAll("_", " ")}
  </span>
);

dashboard.get("/dashboard/settlements", async (c) => {
  const orgId = c.get("orgId");
  const org = await getOrg(c.env.DB, orgId);
  const settlements = await listSettlements(c.env.DB, orgId);
  const error = c.req.query("error");

  return c.html(
    <Layout title="Settlements" orgName={org?.name}>
      <h2>Enter a settlement record</h2>
      <p class="muted">
        The rail's confirmation of what was actually charged — a card record,
        a stablecoin transaction, a checkout receipt. VeriSpend matches each
        one to the purchase that authorized it and flags anything no agent
        ever requested. Feeds can also push these to the settlements API.
      </p>
      {error && <p style="color:#dc2626">{error}</p>}
      <form method="post" action="/dashboard/settlements" style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:1.5rem">
        <select name="rail">
          {SETTLEMENT_RAILS.map((r) => (
            <option value={r}>{r.replaceAll("_", " ")}</option>
          ))}
        </select>
        <input name="settlement_ref" placeholder="Rail reference (auth code, tx hash…)" required />
        <input name="vendor" placeholder="Vendor" required />
        <input name="amount_cents" type="number" min="1" placeholder="Amount (cents)" required />
        <input name="currency" placeholder="USD" value="USD" size={5} />
        <input name="occurred_at" type="datetime-local" required />
        <button class="btn" style="background:#0f172a">Match</button>
      </form>

      <h2>Settlements</h2>
      {settlements.length === 0 ? (
        <p class="muted">No settlements ingested yet.</p>
      ) : (
        <table>
          <tr>
            <th>Occurred (UTC)</th>
            <th>Rail</th>
            <th>Vendor</th>
            <th>Amount</th>
            <th>Reference</th>
            <th>Match</th>
            <th>Variance</th>
            <th>Purchase</th>
          </tr>
          {settlements.map((s) => (
            <tr>
              <td>{s.occurred_at.slice(0, 16).replace("T", " ")}</td>
              <td>{s.rail.replaceAll("_", " ")}</td>
              <td>{s.vendor}</td>
              <td>{fmt(s.amount_cents, s.currency)}</td>
              <td>
                <code>{s.settlement_ref}</code>
              </td>
              <td>
                <MatchPill status={s.match_status} />
                <div class="muted">{s.match_method.replaceAll("_", " ")}</div>
              </td>
              <td style={s.variance_cents > 0 ? "color:#dc2626" : undefined}>
                {s.variance_cents >= 0 ? "+" : ""}
                {fmt(s.variance_cents, s.currency)}
              </td>
              <td>
                {s.matched_request_id ? (
                  <a href={`/dashboard/requests/${s.matched_request_id}`}>view</a>
                ) : (
                  <span class="muted">none</span>
                )}
              </td>
            </tr>
          ))}
        </table>
      )}
    </Layout>
  );
});

dashboard.post("/dashboard/settlements", async (c) => {
  const form = await c.req.formData();
  const occurredAtRaw = String(form.get("occurred_at") ?? "");
  const result = await ingestSettlement(c.env, {
    orgId: c.get("orgId"),
    rail: String(form.get("rail") ?? ""),
    payload: {
      settlement_ref: String(form.get("settlement_ref") ?? ""),
      vendor: String(form.get("vendor") ?? ""),
      amount_cents: Number(form.get("amount_cents")),
      currency: String(form.get("currency") ?? "") || "USD",
      // datetime-local has no zone; treat it as UTC like everything else.
      occurred_at: occurredAtRaw && !occurredAtRaw.endsWith("Z") ? `${occurredAtRaw}Z` : occurredAtRaw,
    },
    enteredBy: c.get("email"),
  });
  if (!result.ok) {
    return c.redirect(
      `/dashboard/settlements?error=${encodeURIComponent(result.error)}`
    );
  }
  return c.redirect("/dashboard/settlements");
});

// ---------- Trusted mandate issuers (Phase 3) ----------

dashboard.get("/dashboard/issuers", async (c) => {
  const orgId = c.get("orgId");
  const org = await getOrg(c.env.DB, orgId);
  const issuers = await listMandateIssuers(c.env.DB, orgId);
  const error = c.req.query("error");
  const isAdmin = c.get("role") === "admin";

  return c.html(
    <Layout title="Mandate issuers" orgName={org?.name}>
      <h2>Trusted mandate issuers</h2>
      <p class="muted">
        VeriSpend accepts a payment mandate only when it is signed by a key
        registered here. Register the published public key of each network
        your agents hold credentials from (Google AP2, Visa Verified Agent
        ID, Stripe) — that is the entire integration. Re-registering an
        issuer replaces its key.
      </p>
      {error && <p style="color:#dc2626">{error}</p>}
      {isAdmin && (
        <form method="post" action="/dashboard/issuers" style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:1.5rem;align-items:flex-start">
          <input name="issuer" placeholder='Issuer ("iss" claim)' required />
          <select name="scheme">
            {MANDATE_SCHEMES.map((s) => (
              <option value={s}>{s.replaceAll("_", " ")}</option>
            ))}
          </select>
          <select name="alg">
            {MANDATE_ALGS.map((a) => (
              <option value={a}>{a}</option>
            ))}
          </select>
          <textarea name="public_key_jwk" placeholder='Public key JWK, e.g. {"kty":"OKP","crv":"Ed25519","x":"…"}' rows={2} style="width:26rem" required />
          <button class="btn" style="background:#0f172a">Register</button>
        </form>
      )}

      {issuers.length === 0 ? (
        <p class="muted">No issuers registered; agents cannot present mandates yet.</p>
      ) : (
        <table>
          <tr>
            <th>Issuer</th>
            <th>Scheme</th>
            <th>Algorithm</th>
            <th>Registered (UTC)</th>
            <th>Status</th>
            {isAdmin && <th />}
          </tr>
          {issuers.map((i) => (
            <tr>
              <td>
                <code>{i.issuer}</code>
              </td>
              <td>{i.scheme.replaceAll("_", " ")}</td>
              <td>{i.alg}</td>
              <td>{i.created_at.slice(0, 16).replace("T", " ")}</td>
              <td>
                {i.revoked_at ? (
                  <span class="pill" style="background:#6b7280">revoked</span>
                ) : (
                  <span class="pill" style="background:#16a34a">active</span>
                )}
              </td>
              {isAdmin && (
                <td>
                  {!i.revoked_at && (
                    <form method="post" action="/dashboard/issuers/revoke" style="display:inline">
                      <input type="hidden" name="issuer_id" value={i.id} />
                      <button class="btn" style="background:#dc2626">Revoke</button>
                    </form>
                  )}
                </td>
              )}
            </tr>
          ))}
        </table>
      )}
    </Layout>
  );
});

dashboard.post("/dashboard/issuers", async (c) => {
  const form = await c.req.formData();
  const issuer = String(form.get("issuer") ?? "").trim();
  const scheme = String(form.get("scheme") ?? "");
  const alg = String(form.get("alg") ?? "");
  const jwkRaw = String(form.get("public_key_jwk") ?? "");
  const fail = (error: string) =>
    c.redirect(`/dashboard/issuers?error=${encodeURIComponent(error)}`);
  if (!issuer) return fail("issuer is required");
  if (!(MANDATE_SCHEMES as readonly string[]).includes(scheme)) {
    return fail("unknown scheme");
  }
  if (!(MANDATE_ALGS as readonly string[]).includes(alg)) {
    return fail("unknown algorithm");
  }
  let jwk: unknown;
  try {
    jwk = JSON.parse(jwkRaw);
  } catch {
    return fail("public key must be valid JWK JSON");
  }
  if (typeof jwk !== "object" || jwk === null) {
    return fail("public key must be a JWK object");
  }
  await insertMandateIssuer(c.env.DB, {
    orgId: c.get("orgId"),
    issuer,
    scheme,
    alg,
    publicKeyJwk: JSON.stringify(jwk),
  });
  return c.redirect("/dashboard/issuers");
});

dashboard.post("/dashboard/issuers/revoke", async (c) => {
  const form = await c.req.formData();
  await revokeMandateIssuer(
    c.env.DB,
    c.get("orgId"),
    String(form.get("issuer_id") ?? "")
  );
  return c.redirect("/dashboard/issuers");
});

dashboard.get("/dashboard/policy", async (c) => {
  const org = await getOrg(c.env.DB, c.get("orgId"));
  const policy = await getActivePolicy(c.env.DB, c.get("orgId"));
  const saved = c.req.query("saved");
  return c.html(
    <Layout title="Policy" orgName={org?.name}>
      <h2>Spend policy {policy && <span class="muted">v{policy.version}</span>}</h2>
      {saved && <p style="color:#16a34a">Saved as version {saved}.</p>}
      <p class="muted">
        Edits create a new immutable version; past decisions keep the version
        they were evaluated under. Amounts are integer cents.
      </p>
      <form method="post" action="/dashboard/policy">
        <textarea name="rules" rows={18} readonly={c.get("role") !== "admin"}>
          {JSON.stringify(policy?.rules ?? {}, null, 2)}
        </textarea>
        {c.get("role") === "admin" ? (
          <button class="btn" style="background:#0f172a;margin-top:0.6rem">
            Save new version
          </button>
        ) : (
          <p class="muted">Only admins can edit the policy.</p>
        )}
      </form>
    </Layout>
  );
});

dashboard.post("/dashboard/policy", async (c) => {
  const form = await c.req.formData();
  let rules: PolicyRules;
  try {
    rules = JSON.parse(String(form.get("rules") ?? ""));
    if (typeof rules.currency !== "string" || !rules.currency) {
      throw new Error("policy must set a currency, e.g. \"USD\"");
    }
  } catch (error) {
    return c.text(
      `Invalid policy JSON: ${error instanceof Error ? error.message : error}`,
      400
    );
  }
  const orgId = c.get("orgId");
  const { version } = await insertPolicy(c.env.DB, { orgId, rules });
  await c.env.ORG.getByName(orgId).appendEvent({
    orgId,
    requestId: "policy",
    eventType: "policy_updated",
    payload: { version, editedBy: c.get("email") },
  });
  return c.redirect(`/dashboard/policy?saved=${version}`);
});

dashboard.get("/dashboard/keys", async (c) => {
  const orgId = c.get("orgId");
  const org = await getOrg(c.env.DB, orgId);
  const keys = await listAgentKeys(c.env.DB, orgId);
  const frozen = await c.env.ORG.getByName(orgId).frozenAgents();
  return c.html(
    <Layout title="Agent keys" orgName={org?.name}>
      {frozen.length > 0 && (
        <>
          <h2>Frozen agents</h2>
          <table style="margin-bottom:1.5rem">
            <tr>
              <th>Agent</th>
              <th>Frozen (UTC)</th>
              <th>Signal</th>
              <th>Reason</th>
              <th />
            </tr>
            {frozen.map((f) => (
              <tr>
                <td>
                  <span class="pill" style="background:#dc2626">frozen</span>{" "}
                  {f.agent_id}
                </td>
                <td>{f.frozen_at.slice(0, 16).replace("T", " ")}</td>
                <td>{f.signal.replaceAll("_", " ")}</td>
                <td class="muted">{f.reason}</td>
                <td>
                  {c.get("role") === "admin" && (
                    <form method="post" action="/dashboard/agents/unfreeze">
                      <input type="hidden" name="agent_id" value={f.agent_id} />
                      <button class="btn" style="background:#16a34a">Unfreeze</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </table>
        </>
      )}
      <h2>Agent API keys</h2>
      {c.get("role") === "admin" && (
        <form method="post" action="/dashboard/keys/create" style="display:flex;gap:0.5rem;margin-bottom:1rem">
          <input name="agent_id" placeholder="Agent id, e.g. travel-agent" required />
          <button class="btn" style="background:#0f172a">Create key</button>
        </form>
      )}
      <table>
        <tr>
          <th>Agent</th>
          <th>Created (UTC)</th>
          <th>Status</th>
          <th />
        </tr>
        {keys.map((k) => (
          <tr>
            <td>{k.agent_id}</td>
            <td>{k.created_at.slice(0, 16).replace("T", " ")}</td>
            <td>{k.revoked_at ? <span class="muted">revoked</span> : "active"}</td>
            <td>
              {!k.revoked_at && c.get("role") === "admin" && (
                <form method="post" action="/dashboard/keys/revoke">
                  <input type="hidden" name="key_id" value={k.id} />
                  <button class="btn" style="background:#dc2626">Revoke</button>
                </form>
              )}
            </td>
          </tr>
        ))}
      </table>
    </Layout>
  );
});

dashboard.post("/dashboard/keys/create", async (c) => {
  const form = await c.req.formData();
  const agentId = String(form.get("agent_id") ?? "").trim();
  if (!agentId) return c.text("agent_id is required", 400);
  const { apiKey } = await createAgentKey(c.env.DB, {
    orgId: c.get("orgId"),
    agentId,
  });
  const org = await getOrg(c.env.DB, c.get("orgId"));
  return c.html(
    <Layout title="Key created" orgName={org?.name}>
      <h2>Key created for {agentId}</h2>
      <p>
        Copy it now — it is shown exactly once and only a hash is stored:
      </p>
      <p>
        <code style="font-size:1.05rem">{apiKey}</code>
      </p>
      <p class="muted">
        Configure the agent's MCP client with header{" "}
        <code>Authorization: Bearer {"<key>"}</code> against{" "}
        <code>{c.env.BASE_URL}/mcp</code>.
      </p>
      <a href="/dashboard/keys">Back to keys</a>
    </Layout>
  );
});

dashboard.post("/dashboard/agents/unfreeze", async (c) => {
  const form = await c.req.formData();
  const agentId = String(form.get("agent_id") ?? "").trim();
  if (!agentId) return c.text("agent_id is required", 400);
  const orgId = c.get("orgId");
  const coordinator = c.env.ORG.getByName(orgId);
  const { ok } = await coordinator.unfreeze({ agentId });
  if (ok) {
    await coordinator.appendEvent({
      orgId,
      requestId: "breaker",
      eventType: "breaker_reset",
      payload: { agentId, unfrozenBy: c.get("email") },
    });
  }
  return c.redirect("/dashboard/keys");
});

dashboard.post("/dashboard/keys/revoke", async (c) => {
  const form = await c.req.formData();
  await revokeAgentKey(c.env.DB, c.get("orgId"), String(form.get("key_id") ?? ""));
  return c.redirect("/dashboard/keys");
});

// ---------- Request detail (explainability) ----------

const TRACE_COLORS: Record<string, string> = {
  pass: "#16a34a",
  triggered: "#dc2626",
  skipped: "#6b7280",
};

const TraceTable = ({ trace }: { trace: Array<{ rule: string; result: string; detail?: string }> }) => (
  <table style="margin-bottom:1rem">
    <tr>
      <th>Rule</th>
      <th>Result</th>
      <th>Detail</th>
    </tr>
    {trace.map((t) => (
      <tr>
        <td>
          <code>{t.rule}</code>
        </td>
        <td>
          <span class="pill" style={`background:${TRACE_COLORS[t.result] ?? "#6b7280"}`}>
            {t.result}
          </span>
        </td>
        <td class="muted">{t.detail ?? ""}</td>
      </tr>
    ))}
  </table>
);

dashboard.get("/dashboard/requests/:id", async (c) => {
  const orgId = c.get("orgId");
  const row = await getPurchaseRequest(c.env.DB, orgId, c.req.param("id"));
  if (!row) return c.text("No such request", 404);
  const org = await getOrg(c.env.DB, orgId);
  const events = await listLedgerEventsForRequest(c.env.DB, orgId, row.id);
  const mandate = await getMandateForRequest(c.env.DB, orgId, row.id);
  const settlements = await listSettlementsForRequest(c.env.DB, orgId, row.id);
  const receipt = await getLatestReceipt(c.env.DB, orgId, row.id);
  const canAct = c.get("role") !== "viewer";

  return c.html(
    <Layout title={`Request ${row.id}`} orgName={org?.name}>
      <h2>
        {row.vendor} — {fmt(row.amount_cents, row.currency)}{" "}
        <StatusPill status={row.status} />
      </h2>
      <table style="margin-bottom:1.5rem">
        <tr><th>Request</th><td><code>{row.id}</code></td></tr>
        <tr><th>Agent</th><td>{row.agent_id}</td></tr>
        <tr><th>Category</th><td>{row.category}</td></tr>
        <tr><th>Justification</th><td>{row.justification}</td></tr>
        <tr><th>Requested (UTC)</th><td>{row.created_at}</td></tr>
        <tr><th>Rule fired</th><td><code>{row.rule_fired}</code></td></tr>
        {row.denial_reason && (
          <tr><th>Denial reason</th><td>{row.denial_reason}</td></tr>
        )}
        {row.approver && <tr><th>Decided by</th><td>{row.approver}</td></tr>}
        {row.decided_at && <tr><th>Decided (UTC)</th><td>{row.decided_at}</td></tr>}
        {row.outcome_amount_cents !== null && (
          <tr><th>Final charge</th><td>{fmt(row.outcome_amount_cents, row.currency)}</td></tr>
        )}
        {row.settlement_ref && (
          <tr>
            <th>Reported settlement</th>
            <td>
              {row.settlement_rail?.replaceAll("_", " ")} ref{" "}
              <code>{row.settlement_ref}</code>
            </td>
          </tr>
        )}
      </table>

      {mandate && (
        <>
          <h3>Payment mandate</h3>
          <table style="margin-bottom:1.5rem">
            <tr>
              <th>Verification</th>
              <td>
                <span
                  class="pill"
                  style={`background:${mandate.verification_status === "verified" ? "#16a34a" : "#dc2626"}`}
                >
                  {mandate.verification_status.replaceAll("_", " ")}
                </span>
              </td>
            </tr>
            <tr><th>Issuer</th><td><code>{mandate.issuer}</code> ({mandate.scheme.replaceAll("_", " ")})</td></tr>
            <tr><th>Subject</th><td>{mandate.subject}</td></tr>
            <tr><th>Mandate ref</th><td><code>{mandate.mandate_ref}</code></td></tr>
            <tr><th>Scope</th><td><code>{mandate.scope_json}</code></td></tr>
            {mandate.expires_at && <tr><th>Expires (UTC)</th><td>{mandate.expires_at}</td></tr>}
          </table>
        </>
      )}

      {settlements.length > 0 && (
        <>
          <h3>Settlement</h3>
          <table style="margin-bottom:1.5rem">
            <tr>
              <th>Rail</th>
              <th>Reference</th>
              <th>Settled</th>
              <th>Occurred (UTC)</th>
              <th>Match</th>
              <th>Variance</th>
            </tr>
            {settlements.map((s) => (
              <tr>
                <td>{s.rail.replaceAll("_", " ")}</td>
                <td><code>{s.settlement_ref}</code></td>
                <td>{fmt(s.amount_cents, s.currency)}</td>
                <td>{s.occurred_at.slice(0, 16).replace("T", " ")}</td>
                <td><MatchPill status={s.match_status} /></td>
                <td>
                  {s.variance_cents >= 0 ? "+" : ""}
                  {fmt(s.variance_cents, s.currency)}
                </td>
              </tr>
            ))}
          </table>
        </>
      )}

      <h3>Verifiable receipt</h3>
      {receipt ? (
        <p>
          Receipt <code>{receipt.id}</code> issued{" "}
          {receipt.created_at.slice(0, 16).replace("T", " ")} UTC by{" "}
          {receipt.issued_by} —{" "}
          <a href={`/dashboard/requests/${row.id}/receipt.json`}>download</a>
          <span class="muted">
            {" "}
            (verify offline with <code>scripts/verify-receipt.ts</code>)
          </span>
        </p>
      ) : (
        <p class="muted">No receipt issued yet.</p>
      )}
      {canAct && row.status !== "pending_approval" && (
        <form method="post" action={`/dashboard/requests/${row.id}/receipt`} style="margin-bottom:1.5rem">
          <button class="btn" style="background:#0f172a">
            {receipt ? "Reissue signed receipt" : "Issue signed receipt"}
          </button>
        </form>
      )}

      <h3>Ledger timeline</h3>
      {events.map((e) => {
        const payload = JSON.parse(e.payload_json) as Record<string, unknown>;
        const trace = Array.isArray(payload.trace)
          ? (payload.trace as Array<{ rule: string; result: string; detail?: string }>)
          : null;
        return (
          <div style="margin-bottom:1.2rem">
            <p style="margin-bottom:0.4rem">
              <strong>{e.event_type.replaceAll("_", " ")}</strong>{" "}
              <span class="muted">
                #{e.seq} · {e.created_at.slice(0, 19).replace("T", " ")} UTC
              </span>
            </p>
            {trace ? (
              <TraceTable trace={trace} />
            ) : (
              <pre style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:6px;padding:0.6rem;font-size:0.8rem;overflow-x:auto">
                {JSON.stringify(payload, null, 2)}
              </pre>
            )}
          </div>
        );
      })}
      <p class="muted">
        Every event above is hash-chained on the tamper-evident ledger; the{" "}
        <a href="/dashboard/audit">audit page</a> re-verifies the full chain.
      </p>
    </Layout>
  );
});

dashboard.post("/dashboard/requests/:id/receipt", async (c) => {
  const requestId = c.req.param("id");
  const result = await issueReceipt(c.env, {
    orgId: c.get("orgId"),
    requestId,
    issuedBy: c.get("email"),
  });
  if (!result.ok) return c.text(result.error, 400);
  return c.redirect(`/dashboard/requests/${requestId}`);
});

dashboard.get("/dashboard/requests/:id/receipt.json", async (c) => {
  const row = await getLatestReceipt(
    c.env.DB,
    c.get("orgId"),
    c.req.param("id")
  );
  if (!row) return c.text("No receipt issued for this request", 404);
  return c.body(row.receipt_json, 200, {
    "content-type": "application/json",
    "content-disposition": `attachment; filename="verispend-receipt-${row.id}.json"`,
  });
});

// ---------- Teams ----------

dashboard.get("/dashboard/teams", async (c) => {
  const orgId = c.get("orgId");
  const org = await getOrg(c.env.DB, orgId);
  const teams = await listTeams(c.env.DB, orgId);
  const policy = await getActivePolicy(c.env.DB, orgId);
  const isAdmin = c.get("role") === "admin";
  return c.html(
    <Layout title="Teams" orgName={org?.name}>
      <h2>Teams</h2>
      <p class="muted">
        A team's agents share one budget, and its approvers receive the team's
        approval requests. Team budgets live in the spend policy under{" "}
        <code>budgets.teams</code>.
      </p>
      {isAdmin && (
        <form method="post" action="/dashboard/teams" style="display:flex;gap:0.5rem;margin-bottom:1rem">
          <input name="name" placeholder="Team name, e.g. research" required />
          <button class="btn" style="background:#0f172a">Create team</button>
        </form>
      )}
      <table>
        <tr>
          <th>Team</th>
          <th>Agents</th>
          <th>Daily budget</th>
          <th>Monthly budget</th>
        </tr>
        {teams.map((t) => {
          const limits = policy ? resolveTeamLimits(policy.rules, t.id) : undefined;
          return (
            <tr>
              <td>
                <a href={`/dashboard/teams/${t.id}`}>{t.name}</a>
              </td>
              <td>{t.agent_count}</td>
              <td>{limits?.dailyCents !== undefined ? fmt(limits.dailyCents, policy?.rules.currency) : <span class="muted">—</span>}</td>
              <td>{limits?.monthlyCents !== undefined ? fmt(limits.monthlyCents, policy?.rules.currency) : <span class="muted">—</span>}</td>
            </tr>
          );
        })}
      </table>
    </Layout>
  );
});

dashboard.post("/dashboard/teams", async (c) => {
  const form = await c.req.formData();
  const name = String(form.get("name") ?? "").trim();
  if (!name) return c.text("name is required", 400);
  const { teamId } = await createTeam(c.env.DB, { orgId: c.get("orgId"), name });
  return c.redirect(`/dashboard/teams/${teamId}`);
});

dashboard.get("/dashboard/teams/:teamId", async (c) => {
  const orgId = c.get("orgId");
  const team = await getTeam(c.env.DB, orgId, c.req.param("teamId"));
  if (!team) return c.text("No such team", 404);
  const org = await getOrg(c.env.DB, orgId);
  const policy = await getActivePolicy(c.env.DB, orgId);
  const limits = policy ? resolveTeamLimits(policy.rules, team.id) : undefined;
  const agents = await listTeamAgents(c.env.DB, team.id);
  const approvers = await listTeamApprovers(c.env.DB, team.id);
  const approverIds = new Set(approvers.map((a) => a.id));
  const members = (await listMembers(c.env.DB, orgId)).filter(
    (m) => m.role !== "viewer"
  );
  const knownAgents = await listKnownAgentIds(c.env.DB, orgId);
  const isAdmin = c.get("role") === "admin";
  return c.html(
    <Layout title={`Team ${team.name}`} orgName={org?.name}>
      <h2>Team: {team.name}</h2>

      <h3>Agents</h3>
      <p class="muted">
        Each agent belongs to at most one team. Reassigning an agent moves its
        future spend to the new team; spend already counted stays where it was.
      </p>
      {agents.length === 0 ? (
        <p class="muted">No agents assigned.</p>
      ) : (
        <table style="margin-bottom:0.8rem">
          {agents.map((a) => (
            <tr>
              <td>
                <code>{a}</code>
              </td>
              <td>
                {isAdmin && (
                  <form method="post" action={`/dashboard/teams/${team.id}/agents`}>
                    <input type="hidden" name="agent_id" value={a} />
                    <input type="hidden" name="action" value="remove" />
                    <button class="btn" style="background:#dc2626">Remove</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </table>
      )}
      {isAdmin && (
        <form method="post" action={`/dashboard/teams/${team.id}/agents`} style="display:flex;gap:0.5rem;margin-bottom:1.5rem">
          <input name="agent_id" list="known-agents" placeholder="Agent id" required />
          <datalist id="known-agents">
            {knownAgents.map((a) => (
              <option value={a} />
            ))}
          </datalist>
          <input type="hidden" name="action" value="add" />
          <button class="btn" style="background:#0f172a">Assign agent</button>
        </form>
      )}

      <h3>Approvers</h3>
      <p class="muted">
        These members get this team's approval emails. With none set, requests
        route to all org admins and approvers.
      </p>
      {isAdmin ? (
        <form method="post" action={`/dashboard/teams/${team.id}/approvers`} style="margin-bottom:1.5rem">
          {members.map((m) => (
            <label style="display:block;margin-bottom:0.3rem">
              <input
                type="checkbox"
                name="member_id"
                value={m.id}
                checked={approverIds.has(m.id)}
              />{" "}
              {m.email} <span class="muted">({m.role})</span>
            </label>
          ))}
          <button class="btn" style="background:#0f172a">Save approvers</button>
        </form>
      ) : (
        <p style="margin-bottom:1.5rem">
          {approvers.length === 0 ? (
            <span class="muted">None (org-wide routing)</span>
          ) : (
            approvers.map((a) => a.email).join(", ")
          )}
        </p>
      )}

      <h3>Shared budget</h3>
      <p class="muted">
        Saving writes a new policy version with{" "}
        <code>budgets.teams["{team.id}"]</code>. Blank means no limit.
      </p>
      {isAdmin ? (
        <form method="post" action={`/dashboard/teams/${team.id}/budget`} style="display:flex;gap:0.5rem">
          <input
            name="daily_cents"
            type="number"
            min="0"
            placeholder="Daily (cents)"
            value={limits?.dailyCents !== undefined ? String(limits.dailyCents) : ""}
          />
          <input
            name="monthly_cents"
            type="number"
            min="0"
            placeholder="Monthly (cents)"
            value={limits?.monthlyCents !== undefined ? String(limits.monthlyCents) : ""}
          />
          <button class="btn" style="background:#0f172a">Save budget</button>
        </form>
      ) : (
        <p>
          daily: {limits?.dailyCents !== undefined ? fmt(limits.dailyCents, policy?.rules.currency) : "—"}, monthly:{" "}
          {limits?.monthlyCents !== undefined ? fmt(limits.monthlyCents, policy?.rules.currency) : "—"}
        </p>
      )}
    </Layout>
  );
});

dashboard.post("/dashboard/teams/:teamId/agents", async (c) => {
  const orgId = c.get("orgId");
  const team = await getTeam(c.env.DB, orgId, c.req.param("teamId"));
  if (!team) return c.text("No such team", 404);
  const form = await c.req.formData();
  const agentId = String(form.get("agent_id") ?? "").trim();
  if (!agentId) return c.text("agent_id is required", 400);
  await setAgentTeam(c.env.DB, {
    orgId,
    agentId,
    teamId: form.get("action") === "remove" ? null : team.id,
  });
  return c.redirect(`/dashboard/teams/${team.id}`);
});

dashboard.post("/dashboard/teams/:teamId/approvers", async (c) => {
  const orgId = c.get("orgId");
  const team = await getTeam(c.env.DB, orgId, c.req.param("teamId"));
  if (!team) return c.text("No such team", 404);
  const form = await c.req.formData();
  const selected = new Set(form.getAll("member_id").map(String));
  // Only non-viewer members of this org may be team approvers.
  const eligible = (await listMembers(c.env.DB, orgId)).filter(
    (m) => m.role !== "viewer"
  );
  for (const member of eligible) {
    await setTeamApprover(c.env.DB, {
      teamId: team.id,
      memberId: member.id,
      on: selected.has(member.id),
    });
  }
  return c.redirect(`/dashboard/teams/${team.id}`);
});

dashboard.post("/dashboard/teams/:teamId/budget", async (c) => {
  const orgId = c.get("orgId");
  const team = await getTeam(c.env.DB, orgId, c.req.param("teamId"));
  if (!team) return c.text("No such team", 404);
  const policy = await getActivePolicy(c.env.DB, orgId);
  if (!policy) return c.text("No policy configured", 400);
  const form = await c.req.formData();
  const parse = (v: unknown) => {
    const s = String(v ?? "").trim();
    if (!s) return undefined;
    const n = Number(s);
    return Number.isInteger(n) && n >= 0 ? n : null;
  };
  const daily = parse(form.get("daily_cents"));
  const monthly = parse(form.get("monthly_cents"));
  if (daily === null || monthly === null) {
    return c.text("Budgets must be non-negative integer cents.", 400);
  }

  const rules = { ...policy.rules };
  rules.budgets = { ...rules.budgets, teams: { ...rules.budgets?.teams } };
  if (daily === undefined && monthly === undefined) {
    delete rules.budgets.teams![team.id];
  } else {
    rules.budgets.teams![team.id] = {
      ...(daily !== undefined ? { dailyCents: daily } : {}),
      ...(monthly !== undefined ? { monthlyCents: monthly } : {}),
    };
  }
  const { version } = await insertPolicy(c.env.DB, { orgId, rules });
  await c.env.ORG.getByName(orgId).appendEvent({
    orgId,
    requestId: "policy",
    eventType: "policy_updated",
    payload: { version, editedBy: c.get("email"), via: "teams_page", teamId: team.id },
  });
  return c.redirect(`/dashboard/teams/${team.id}`);
});

dashboard.get("/dashboard/members", async (c) => {
  const orgId = c.get("orgId");
  const org = await getOrg(c.env.DB, orgId);
  const members = await listMembers(c.env.DB, orgId);
  const isAdmin = c.get("role") === "admin";
  const error = c.req.query("error");
  return c.html(
    <Layout title="Members" orgName={org?.name}>
      <h2>Members</h2>
      <p class="muted">
        Admins manage policy, keys, teams, and members. Approvers decide
        pending purchases. Viewers have read-only access.
      </p>
      {error && <p style="color:#dc2626">{error}</p>}
      {isAdmin && (
        <form method="post" action="/dashboard/members" style="display:flex;gap:0.5rem;margin-bottom:1rem">
          <input name="email" type="email" placeholder="person@company.com" required />
          <select name="role">
            {MEMBER_ROLES.map((r) => (
              <option value={r}>{r}</option>
            ))}
          </select>
          <button class="btn" style="background:#0f172a">Add member</button>
        </form>
      )}
      <table>
        <tr>
          <th>Email</th>
          <th>Role</th>
          <th>Added (UTC)</th>
          {isAdmin && <th />}
        </tr>
        {members.map((m) => (
          <tr>
            <td>{m.email}</td>
            <td>
              {isAdmin ? (
                <form method="post" action="/dashboard/members" style="display:flex;gap:0.4rem">
                  <input type="hidden" name="email" value={m.email} />
                  <select name="role">
                    {MEMBER_ROLES.map((r) => (
                      <option value={r} selected={r === m.role}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <button class="btn" style="background:#0f172a">Set</button>
                </form>
              ) : (
                m.role
              )}
            </td>
            <td>{m.created_at.slice(0, 16).replace("T", " ")}</td>
            {isAdmin && (
              <td>
                <form method="post" action="/dashboard/members/delete">
                  <input type="hidden" name="member_id" value={m.id} />
                  <button class="btn" style="background:#dc2626">Remove</button>
                </form>
              </td>
            )}
          </tr>
        ))}
      </table>
    </Layout>
  );
});

dashboard.post("/dashboard/members", async (c) => {
  const orgId = c.get("orgId");
  const form = await c.req.formData();
  const email = String(form.get("email") ?? "").trim();
  const role = String(form.get("role") ?? "") as MemberRole;
  if (!email || !MEMBER_ROLES.includes(role)) {
    return c.text("email and a valid role are required", 400);
  }
  // Demoting the last admin would lock everyone out of member management.
  const existing = await getMembership(c.env.DB, orgId, email);
  if (existing?.role === "admin" && role !== "admin") {
    if ((await countAdmins(c.env.DB, orgId)) <= 1) {
      return c.text("Cannot demote the last admin.", 400);
    }
  }
  await upsertMember(c.env.DB, { orgId, email, role });
  return c.redirect("/dashboard/members");
});

dashboard.post("/dashboard/members/delete", async (c) => {
  const orgId = c.get("orgId");
  const form = await c.req.formData();
  const memberId = String(form.get("member_id") ?? "");
  const member = await getMemberById(c.env.DB, orgId, memberId);
  if (!member) return c.redirect("/dashboard/members");
  if (member.role === "admin" && (await countAdmins(c.env.DB, orgId)) <= 1) {
    return c.text("Cannot remove the last admin.", 400);
  }
  await deleteMember(c.env.DB, orgId, memberId);
  return c.redirect("/dashboard/members");
});

dashboard.get("/dashboard/audit", async (c) => {
  const orgId = c.get("orgId");
  const org = await getOrg(c.env.DB, orgId);
  const verification = await verifyLedgerChain(c.env.DB, orgId);
  return c.html(
    <Layout title="Audit" orgName={org?.name}>
      <h2>Ledger integrity</h2>
      {verification.ok ? (
        <p style="color:#16a34a">
          ✔ Hash chain verified — {verification.count} events, none altered.
        </p>
      ) : (
        <p style="color:#dc2626">
          ✘ Chain broken at event #{verification.brokenAtSeq}: {verification.reason}
        </p>
      )}
      <p class="muted">
        Every purchase request, decision, and outcome is an append-only,
        hash-chained event. This check recomputes the full chain.
      </p>
    </Layout>
  );
});
