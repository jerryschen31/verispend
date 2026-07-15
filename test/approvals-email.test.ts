import { describe, expect, it, vi } from "vitest";
import {
  sendApprovalEmail,
  sendBreakerAlertEmail,
  sendReconciliationAlertEmail,
} from "../src/approvals";

// Unit tests for the email-composing functions in isolation: a fake env
// captures what would have been sent, without touching the real EMAIL
// binding or any org/DB state.
function fakeEnv() {
  const send = vi.fn().mockResolvedValue(undefined);
  const env = {
    EMAIL: { send },
    EMAIL_FROM: "approvals@test.local",
    BASE_URL: "http://example.com",
  } as unknown as Env;
  return { env, send };
}

describe("email HTML escaping", () => {
  it("escapes agent-controlled fields in the approval email", async () => {
    const { env, send } = fakeEnv();
    await sendApprovalEmail(env, {
      approverEmail: "cfo@example.com",
      orgName: "Acme <script>",
      row: {
        agent_id: '"><img src=x onerror=alert(1)>',
        vendor: "<b>Evil</b> Vendor",
        amount_cents: 100,
        currency: "USD",
        category: "<script>alert(1)</script>",
        justification: "Buy stuff & more <stuff>",
      },
      decisionToken: "dt_test",
    });

    const { html, text } = send.mock.calls[0][0];
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>Evil</b>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
    // Plain-text body is untouched (no markup to inject there).
    expect(text).toContain("<script>alert(1)</script>");
  });

  it("escapes agent-controlled fields in the breaker alert email", async () => {
    const { env, send } = fakeEnv();
    await sendBreakerAlertEmail(env, {
      approverEmail: "cfo@example.com",
      orgName: "Acme Corp",
      agentId: '<img src=x onerror=alert(1)>evil-agent',
      signal: "identical_loop",
      reason:
        'The same purchase ("<script>alert(1)</script>", 300¢, "data") was requested 5 times.',
    });

    const { html } = send.mock.calls[0][0];
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
  });
});

describe("reconciliation email currency", () => {
  it("formats amounts using the org's configured currency, not a hardcoded USD", async () => {
    const { env, send } = fakeEnv();
    await sendReconciliationAlertEmail(env, {
      approverEmail: "cfo@example.com",
      orgName: "Acme Europe",
      vendor: "ComputeCo",
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      billedCents: 15_000,
      expectedCents: 10_000,
      status: "overbilled",
      currency: "EUR",
    });

    const { text, subject } = send.mock.calls[0][0];
    expect(subject).toContain("€150.00");
    expect(text).toContain("€150.00");
    expect(text).toContain("€100.00");
    expect(text).not.toContain("$150.00");
  });

  it("still formats USD correctly for USD orgs", async () => {
    const { env, send } = fakeEnv();
    await sendReconciliationAlertEmail(env, {
      approverEmail: "cfo@example.com",
      orgName: "Acme US",
      vendor: "ComputeCo",
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      billedCents: 15_000,
      expectedCents: 10_000,
      status: "overbilled",
      currency: "USD",
    });

    const { text } = send.mock.calls[0][0];
    expect(text).toContain("$150.00");
  });
});
