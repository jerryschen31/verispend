import { Hono } from "hono";
import { decideRequest } from "./approvals";
import { dashboard } from "./dashboard";
import { authenticateApiKey, bearerToken, timingSafeEqualStr } from "./auth";
import {
  MEMBER_ROLES,
  createAgentKey,
  createOrg,
  createTeam,
  getActivePolicy,
  getMembership,
  getOrg,
  insertMandateIssuer,
  insertPolicy,
  revokeMandateIssuer,
  setAgentTeam,
  setTeamApprover,
  upsertMember,
  type MemberRole,
} from "./db";
import type { BudgetLimits } from "./policy";
import { buildAuditBundle, exportPurchasesCsv } from "./export";
import { ingestBill } from "./reconcile";
import { ingestSettlement } from "./settlements";
import { MANDATE_ALGS, MANDATE_SCHEMES } from "./mandate";
import { DEFAULT_POLICY, type PolicyRules } from "./policy";
import { VeriSpendMCP } from "./mcp";
import { OrgCoordinator } from "./org-do";

export { VeriSpendMCP, OrgCoordinator };

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, service: "verispend" }));

app.get("/", (c) => c.redirect("/dashboard"));
app.route("/", dashboard);

// One-click approve/deny links from the approval email. The token is the
// secret; a link can only resolve a request once.
app.get("/decide/:token/:action", async (c) => {
  const action = c.req.param("action");
  if (action !== "approve" && action !== "deny") {
    return c.text("Unknown action", 400);
  }
  const outcome = await decideRequest(c.env, c.req.param("token"), action);
  const page = `<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VeriSpend — ${outcome.title}</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">
  <h1>${outcome.title}</h1>
  <p>${outcome.detail}</p>
  <p style="color:#666">VeriSpend — verified spend for AI agents</p>
</body>`;
  return c.html(page, outcome.ok ? 200 : 410);
});

const requireAdminKey = async (c: { req: { header(name: string): string | undefined }; env: Env }) => {
  const provided = c.req.header("x-admin-key") ?? "";
  if (!c.env.ADMIN_KEY) return false;
  return timingSafeEqualStr(provided, c.env.ADMIN_KEY);
};

// Bootstrap provisioning until the dashboard exists: creates an org with the
// default policy and one agent API key. Guarded by the ADMIN_KEY secret.
app.post("/api/admin/orgs", async (c) => {
  if (!(await requireAdminKey(c))) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const body = await c.req.json<{
    name?: string;
    approver_email?: string;
    agent_id?: string;
    policy?: PolicyRules;
    members?: Array<{ email?: string; role?: MemberRole }>;
  }>();
  if (!body.name || !body.agent_id) {
    return c.json({ error: "name and agent_id are required" }, 400);
  }

  const { orgId } = await createOrg(c.env.DB, {
    name: body.name,
    approverEmail: body.approver_email,
  });
  for (const member of body.members ?? []) {
    if (member.email && member.role && MEMBER_ROLES.includes(member.role)) {
      await upsertMember(c.env.DB, {
        orgId,
        email: member.email,
        role: member.role,
      });
    }
  }
  const { version } = await insertPolicy(c.env.DB, {
    orgId,
    rules: body.policy ?? DEFAULT_POLICY,
  });
  const { apiKey } = await createAgentKey(c.env.DB, {
    orgId,
    agentId: body.agent_id,
  });

  return c.json({
    org_id: orgId,
    policy_version: version,
    agent_id: body.agent_id,
    api_key: apiKey, // shown exactly once; only a hash is stored
  });
});

// Additional agent keys for an existing org (the dashboard's key page is the
// session-guarded equivalent).
app.post("/api/admin/orgs/:orgId/keys", async (c) => {
  if (!(await requireAdminKey(c))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const orgId = c.req.param("orgId");
  if (!(await getOrg(c.env.DB, orgId))) {
    return c.json({ error: "no such org" }, 404);
  }
  const body = await c.req.json<{ agent_id?: string }>();
  if (!body.agent_id) return c.json({ error: "agent_id is required" }, 400);
  const { apiKey } = await createAgentKey(c.env.DB, {
    orgId,
    agentId: body.agent_id,
  });
  return c.json({ agent_id: body.agent_id, api_key: apiKey });
});

// Member management for API-driven workflows (and the agent simulator). The
// dashboard's members page is the session-guarded equivalent.
app.post("/api/admin/orgs/:orgId/members", async (c) => {
  if (!(await requireAdminKey(c))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const orgId = c.req.param("orgId");
  if (!(await getOrg(c.env.DB, orgId))) {
    return c.json({ error: "no such org" }, 404);
  }
  const body = await c.req.json<{ email?: string; role?: MemberRole }>();
  if (!body.email || !body.role || !MEMBER_ROLES.includes(body.role)) {
    return c.json({ error: "email and a valid role are required" }, 400);
  }
  const { id } = await upsertMember(c.env.DB, {
    orgId,
    email: body.email,
    role: body.role,
  });
  return c.json({ member_id: id, email: body.email.trim().toLowerCase(), role: body.role });
});

// Team provisioning for API-driven workflows (and the agent simulator). The
// dashboard's teams pages are the session-guarded equivalent.
app.post("/api/admin/orgs/:orgId/teams", async (c) => {
  if (!(await requireAdminKey(c))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const orgId = c.req.param("orgId");
  if (!(await getOrg(c.env.DB, orgId))) {
    return c.json({ error: "no such org" }, 404);
  }
  const body = await c.req.json<{
    name?: string;
    agent_ids?: string[];
    approver_emails?: string[];
    budgets?: BudgetLimits;
  }>();
  if (!body.name?.trim()) return c.json({ error: "name is required" }, 400);

  const { teamId } = await createTeam(c.env.DB, { orgId, name: body.name });
  for (const agentId of body.agent_ids ?? []) {
    await setAgentTeam(c.env.DB, { orgId, agentId, teamId });
  }
  for (const email of body.approver_emails ?? []) {
    const member = await getMembership(c.env.DB, orgId, email);
    if (!member || member.role === "viewer") {
      return c.json(
        { error: `approver_emails must be existing non-viewer members: ${email}` },
        400
      );
    }
    await setTeamApprover(c.env.DB, { teamId, memberId: member.id, on: true });
  }

  let policyVersion: number | null = null;
  if (body.budgets) {
    const policy = await getActivePolicy(c.env.DB, orgId);
    if (!policy) return c.json({ error: "org has no policy" }, 400);
    const rules = { ...policy.rules };
    rules.budgets = {
      ...rules.budgets,
      teams: { ...rules.budgets?.teams, [teamId]: body.budgets },
    };
    const { version } = await insertPolicy(c.env.DB, { orgId, rules });
    policyVersion = version;
    await c.env.ORG.getByName(orgId).appendEvent({
      orgId,
      requestId: "policy",
      eventType: "policy_updated",
      payload: { version, editedBy: "admin-api", via: "teams_api", teamId },
    });
  }

  return c.json({ team_id: teamId, policy_version: policyVersion });
});

// Trusted mandate-issuer registry (Phase 3). VeriSpend accepts payment
// mandates only from issuers whose public keys an org registered here —
// registering a real network's published key is the entire "integration".
// The dashboard's issuers page is the session-guarded equivalent.
app.post("/api/admin/orgs/:orgId/issuers", async (c) => {
  if (!(await requireAdminKey(c))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const orgId = c.req.param("orgId");
  if (!(await getOrg(c.env.DB, orgId))) {
    return c.json({ error: "no such org" }, 404);
  }
  const body = await c.req.json<{
    issuer?: string;
    scheme?: string;
    alg?: string;
    public_key_jwk?: Record<string, unknown>;
  }>();
  if (!body.issuer?.trim()) return c.json({ error: "issuer is required" }, 400);
  if (!body.scheme || !(MANDATE_SCHEMES as readonly string[]).includes(body.scheme)) {
    return c.json(
      { error: `scheme must be one of: ${MANDATE_SCHEMES.join(", ")}` },
      400
    );
  }
  if (!body.alg || !(MANDATE_ALGS as readonly string[]).includes(body.alg)) {
    return c.json({ error: `alg must be one of: ${MANDATE_ALGS.join(", ")}` }, 400);
  }
  if (typeof body.public_key_jwk !== "object" || body.public_key_jwk === null) {
    return c.json({ error: "public_key_jwk must be a JWK object" }, 400);
  }
  const { issuerId } = await insertMandateIssuer(c.env.DB, {
    orgId,
    issuer: body.issuer,
    scheme: body.scheme,
    alg: body.alg,
    publicKeyJwk: JSON.stringify(body.public_key_jwk),
  });
  return c.json({ issuer_id: issuerId });
});

app.post("/api/admin/orgs/:orgId/issuers/:issuerId/revoke", async (c) => {
  if (!(await requireAdminKey(c))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const orgId = c.req.param("orgId");
  if (!(await getOrg(c.env.DB, orgId))) {
    return c.json({ error: "no such org" }, 404);
  }
  await revokeMandateIssuer(c.env.DB, orgId, c.req.param("issuerId"));
  return c.json({ ok: true });
});

// Bill ingestion for API-driven workflows (and the agent simulator). The
// dashboard form at /dashboard/bills is the session-guarded equivalent.
app.post("/api/admin/orgs/:orgId/bills", async (c) => {
  if (!(await requireAdminKey(c))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const orgId = c.req.param("orgId");
  if (!(await getOrg(c.env.DB, orgId))) {
    return c.json({ error: "no such org" }, 404);
  }
  const body = await c.req.json<{
    vendor?: string;
    period_start?: string;
    period_end?: string;
    amount_cents?: number;
    memo?: string;
  }>();
  const result = await ingestBill(c.env, {
    orgId,
    vendor: body.vendor ?? "",
    periodStart: body.period_start ?? "",
    periodEnd: body.period_end ?? "",
    amountCents: body.amount_cents ?? 0,
    memo: body.memo,
    enteredBy: "admin-api",
  });
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({
    bill_id: result.bill.id,
    expected_cents: result.bill.expected_cents,
    variance_cents: result.bill.variance_cents,
    recon_status: result.bill.recon_status,
  });
});

// Settlement ingestion (Phase 3): rails and finance systems push settlement
// confirmations here; VeriSpend never pulls them. Accepts one record or a
// batch. The dashboard form at /dashboard/settlements is the session-guarded
// equivalent.
app.post("/api/admin/orgs/:orgId/settlements", async (c) => {
  if (!(await requireAdminKey(c))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const orgId = c.req.param("orgId");
  if (!(await getOrg(c.env.DB, orgId))) {
    return c.json({ error: "no such org" }, 404);
  }
  const body = await c.req.json<
    { rail?: string; settlements?: Array<Record<string, unknown>> } & Record<
      string,
      unknown
    >
  >();
  if (typeof body.rail !== "string") {
    return c.json({ error: "rail is required" }, 400);
  }
  const payloads = Array.isArray(body.settlements)
    ? body.settlements
    : [body as Record<string, unknown>];
  const results = [];
  for (const payload of payloads) {
    const result = await ingestSettlement(c.env, {
      orgId,
      rail: body.rail,
      payload,
      enteredBy: "admin-api",
    });
    results.push(
      result.ok
        ? {
            settlement_id: result.settlement.id,
            match_status: result.settlement.match_status,
            match_method: result.settlement.match_method,
            matched_request_id: result.settlement.matched_request_id,
            variance_cents: result.settlement.variance_cents,
            duplicate: result.duplicate,
          }
        : { error: result.error }
    );
  }
  return c.json({ results });
});

// Admin-key twins of the dashboard exports, for the simulator and CI (no
// session machinery in Node). Same query params as the dashboard routes.
app.get("/api/admin/orgs/:orgId/export/purchases.csv", async (c) => {
  if (!(await requireAdminKey(c))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const orgId = c.req.param("orgId");
  if (!(await getOrg(c.env.DB, orgId))) {
    return c.json({ error: "no such org" }, 404);
  }
  const csv = await exportPurchasesCsv(c.env.DB, orgId, {
    from: c.req.query("from") || undefined,
    to: c.req.query("to") || undefined,
    agentId: c.req.query("agent") || undefined,
    status: c.req.query("status") || undefined,
    teamId: c.req.query("team") || undefined,
  });
  return c.body(csv, 200, { "content-type": "text/csv; charset=utf-8" });
});

app.get("/api/admin/orgs/:orgId/export/audit-bundle.json", async (c) => {
  if (!(await requireAdminKey(c))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const orgId = c.req.param("orgId");
  if (!(await getOrg(c.env.DB, orgId))) {
    return c.json({ error: "no such org" }, 404);
  }
  return c.json(await buildAuditBundle(c.env.DB, orgId));
});

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
      const token = bearerToken(request);
      const identity = token
        ? await authenticateApiKey(env.DB, token)
        : null;
      if (!identity) {
        return Response.json(
          { error: "Missing or invalid API key" },
          { status: 401, headers: { "WWW-Authenticate": "Bearer" } }
        );
      }
      // ExecutionContext.props is typed readonly, but assigning it is the
      // documented channel for handing auth context to McpAgent (this.props).
      (ctx as { props: unknown }).props = identity;
      return VeriSpendMCP.serve("/mcp", { binding: "VeriSpendMCP" }).fetch(
        request,
        env,
        ctx
      );
    }
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
