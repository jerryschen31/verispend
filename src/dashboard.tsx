import { Hono, type MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Child } from "hono/jsx";
import { decideRequestById } from "./approvals";
import {
  createAgentKey,
  getActivePolicy,
  getOrg,
  getOrgByApproverEmail,
  insertPolicy,
  listAgentKeys,
  listPurchaseRequests,
  revokeAgentKey,
  type PurchaseRequestRow,
  type RequestStatus,
} from "./db";
import { verifyLedgerChain } from "./ledger";
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

type Vars = { orgId: string; email: string };

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
        <a href="/dashboard/policy">Policy</a>
        <a href="/dashboard/keys">Agent Keys</a>
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
        <td>{r.created_at.slice(0, 16).replace("T", " ")}</td>
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

  const org = await getOrgByApproverEmail(c.env.DB, result.email);
  if (!org) {
    return c.html(
      <body style="font-family:system-ui;max-width:28rem;margin:5rem auto">
        <h1>No org for this account</h1>
        <p>
          You signed in as <strong>{result.email}</strong>, but that address is
          not an approver for any VeriSpend org.
        </p>
        <a href={logoutUrl(c.env)}>Sign in with a different account</a>
      </body>,
      403
    );
  }

  const session = await signToken(c.env.SESSION_SECRET, {
    purpose: "session",
    email: result.email,
    orgId: org.id,
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
  c.set("orgId", payload.orgId);
  c.set("email", payload.email);
  await next();
};
dashboard.use("/dashboard", requireSession);
dashboard.use("/dashboard/*", requireSession);

// ---------- Views ----------

dashboard.get("/dashboard", async (c) => {
  const orgId = c.get("orgId");
  const org = await getOrg(c.env.DB, orgId);
  const pending = await listPurchaseRequests(c.env.DB, orgId, {
    status: "pending_approval",
  });
  const recent = await listPurchaseRequests(c.env.DB, orgId, {
    limit: 15,
  });

  return c.html(
    <Layout title="Approvals" orgName={org?.name}>
      <h2>Pending approvals ({pending.length})</h2>
      {pending.length === 0 ? (
        <p class="muted">Nothing waiting on you.</p>
      ) : (
        <RequestTable rows={pending} actions />
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
    await decideRequestById(c.env, c.get("orgId"), requestId, action);
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

dashboard.get("/dashboard/ledger.csv", async (c) => {
  const rows = await listPurchaseRequests(c.env.DB, c.get("orgId"), {
    limit: 10_000,
  });
  const esc = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const header =
    "id,created_at,agent_id,vendor,amount_cents,currency,category,justification,status,rule_fired,denial_reason,approver,decided_at,outcome_amount_cents";
  const lines = rows.map((r) =>
    [
      r.id,
      r.created_at,
      r.agent_id,
      r.vendor,
      r.amount_cents,
      r.currency,
      r.category,
      r.justification,
      r.status,
      r.rule_fired,
      r.denial_reason,
      r.approver,
      r.decided_at,
      r.outcome_amount_cents,
    ]
      .map(esc)
      .join(",")
  );
  return c.body([header, ...lines].join("\n"), 200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": 'attachment; filename="verispend-ledger.csv"',
  });
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
        <textarea name="rules" rows={18}>
          {JSON.stringify(policy?.rules ?? {}, null, 2)}
        </textarea>
        <button class="btn" style="background:#0f172a;margin-top:0.6rem">
          Save new version
        </button>
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
  const org = await getOrg(c.env.DB, c.get("orgId"));
  const keys = await listAgentKeys(c.env.DB, c.get("orgId"));
  return c.html(
    <Layout title="Agent keys" orgName={org?.name}>
      <h2>Agent API keys</h2>
      <form method="post" action="/dashboard/keys/create" style="display:flex;gap:0.5rem;margin-bottom:1rem">
        <input name="agent_id" placeholder="Agent id, e.g. travel-agent" required />
        <button class="btn" style="background:#0f172a">Create key</button>
      </form>
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
              {!k.revoked_at && (
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

dashboard.post("/dashboard/keys/revoke", async (c) => {
  const form = await c.req.formData();
  await revokeAgentKey(c.env.DB, c.get("orgId"), String(form.get("key_id") ?? ""));
  return c.redirect("/dashboard/keys");
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
