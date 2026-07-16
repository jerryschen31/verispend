// Minimal MCP-over-Streamable-HTTP client, shared by the vitest helpers
// (driving the Worker via SELF.fetch) and the simulator (driving a live
// server via plain fetch). Speaks just enough JSON-RPC to initialize a
// session and call tools.

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function parseSseJson(text: string): any {
  return JSON.parse(
    text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .at(-1)!
      .slice("data: ".length)
  );
}

export class McpHttpClient {
  #fetchFn: FetchLike;
  #endpoint: string;
  #apiKey: string;
  #sessionId: string | undefined;
  #nextId = 1;

  constructor(args: { baseUrl: string; apiKey: string; fetchFn?: FetchLike }) {
    this.#fetchFn = args.fetchFn ?? ((url, init) => fetch(url, init));
    this.#endpoint = `${args.baseUrl.replace(/\/$/, "")}/mcp`;
    this.#apiKey = args.apiKey;
  }

  async #post(body: unknown): Promise<Response> {
    return this.#fetchFn(this.#endpoint, {
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
        clientInfo: { name: "verispend-client", version: "0" },
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
