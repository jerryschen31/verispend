import { SELF } from "cloudflare:test";
import { McpHttpClient } from "../scripts/mcp-client.ts";
import type { PolicyRules } from "../src/policy";

export async function provisionOrg(args: {
  name: string;
  agentId: string;
  approverEmail?: string;
  policy?: PolicyRules;
}): Promise<{ orgId: string; apiKey: string }> {
  const res = await SELF.fetch("http://example.com/api/admin/orgs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-admin-key": "test-admin-key",
    },
    body: JSON.stringify({
      name: args.name,
      agent_id: args.agentId,
      approver_email: args.approverEmail,
      policy: args.policy,
    }),
  });
  if (res.status !== 200) {
    throw new Error(`provisionOrg failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json<{ org_id: string; api_key: string }>();
  return { orgId: body.org_id, apiKey: body.api_key };
}

/** The shared MCP client, wired to the Worker under test via SELF.fetch. */
export class McpSession extends McpHttpClient {
  constructor(apiKey: string) {
    super({
      baseUrl: "http://example.com",
      apiKey,
      fetchFn: (url, init) => SELF.fetch(url, init),
    });
  }
}
