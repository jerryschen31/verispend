import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("health endpoint", () => {
  it("responds ok", async () => {
    const res = await SELF.fetch("http://example.com/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "verispend" });
  });
});
