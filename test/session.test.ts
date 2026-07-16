// Regression coverage for two PR #4 review findings: verifyToken must
// reject tokens with extra "."-delimited segments, and base64url decoding
// (used here and by kinde.ts, mandate.ts, the receipt/report verifiers)
// must handle conventionally-unpadded input.

import { describe, expect, it } from "vitest";
import { b64url, b64urlDecode } from "../src/hash";
import { signToken, verifyToken, type TokenPayload } from "../src/session";

const SECRET = "test-session-secret";

describe("verifyToken", () => {
  const payload: TokenPayload = {
    purpose: "session",
    email: "a@b.test",
    orgId: "org_1",
    exp: Date.now() + 60_000,
  };

  it("round-trips a signed token", async () => {
    const token = await signToken(SECRET, payload);
    expect(await verifyToken(SECRET, token, "session")).toEqual(payload);
  });

  it("rejects a token with an extra appended segment", async () => {
    const token = await signToken(SECRET, payload);
    // A well-formed token is body.sig — smuggling extra data as a third
    // segment must not silently verify against the first two parts.
    const smuggled = `${token}.extra`;
    expect(await verifyToken(SECRET, smuggled, "session")).toBeNull();
  });

  it("rejects a bare body with no signature segment", async () => {
    const token = await signToken(SECRET, payload);
    const [body] = token.split(".");
    expect(await verifyToken(SECRET, body, "session")).toBeNull();
  });

  it("rejects a tampered signature", async () => {
    const token = await signToken(SECRET, payload);
    const [body] = token.split(".");
    expect(await verifyToken(SECRET, `${body}.notarealsignature`, "session")).toBeNull();
  });
});

describe("b64urlDecode", () => {
  it("round-trips arbitrary byte lengths, including unpadded (len % 4 != 0) output", async () => {
    for (let len = 0; len < 12; len++) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => i * 7);
      const encoded = b64url(bytes);
      // b64url() strips padding, so most lengths land here unpadded —
      // exactly the shape JWT/JWS segments and signatures take.
      expect(new Uint8Array(b64urlDecode(encoded))).toEqual(bytes);
    }
  });

  it("decodes a known unpadded base64url string", () => {
    // "hi" -> base64 "aGk=" -> base64url unpadded "aGk"
    expect(new TextDecoder().decode(b64urlDecode("aGk"))).toBe("hi");
  });
});
