import { Hono } from "hono";
import { decideRequest } from "./approvals";
import { dashboard } from "./dashboard";
import { authenticateApiKey, bearerToken, timingSafeEqualStr } from "./auth";
import { createAgentKey, createOrg, insertPolicy } from "./db";
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

// Bootstrap provisioning until the dashboard exists: creates an org with the
// default policy and one agent API key. Guarded by the ADMIN_KEY secret.
app.post("/api/admin/orgs", async (c) => {
  const provided = c.req.header("x-admin-key") ?? "";
  if (!c.env.ADMIN_KEY || !(await timingSafeEqualStr(provided, c.env.ADMIN_KEY))) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const body = await c.req.json<{
    name?: string;
    approver_email?: string;
    agent_id?: string;
    policy?: PolicyRules;
  }>();
  if (!body.name || !body.agent_id) {
    return c.json({ error: "name and agent_id are required" }, 400);
  }

  const { orgId } = await createOrg(c.env.DB, {
    name: body.name,
    approverEmail: body.approver_email,
  });
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
