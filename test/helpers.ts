import { SELF } from "cloudflare:test";
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

function parseSseJson(text: string): any {
  return JSON.parse(
    text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .at(-1)!
      .slice("data: ".length)
  );
}

export class McpSession {
  #apiKey: string;
  #sessionId: string | undefined;
  #nextId = 1;

  constructor(apiKey: string) {
    this.#apiKey = apiKey;
  }

  async #post(body: unknown): Promise<Response> {
    return SELF.fetch("http://example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${this.#apiKey}`,
        ...(this.#sessionId ? { "mcp-session-id": this.#sessionId } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  /** Returns the HTTP status of the initialize call (401 for bad keys). */
  async initialize(): Promise<number> {
    const res = await this.#post({
      jsonrpc: "2.0",
      id: this.#nextId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0" },
      },
    });
    if (res.status !== 200) return res.status;
    this.#sessionId = res.headers.get("mcp-session-id") ?? undefined;
    await this.#post({ jsonrpc: "2.0", method: "notifications/initialized" });
    return 200;
  }

  /** Calls a tool and returns the parsed JSON body of its text content. */
  async call(name: string, args: Record<string, unknown>): Promise<any> {
    const res = await this.#post({
      jsonrpc: "2.0",
      id: this.#nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const message = parseSseJson(await res.text());
    if (message.error) {
      throw new Error(`MCP error: ${JSON.stringify(message.error)}`);
    }
    return JSON.parse(message.result.content[0].text);
  }
}
