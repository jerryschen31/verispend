// Phase 4: every control-plane mutation — identity, trust, config — must
// land on the tamper-evident chain. These tests drive each mutation through
// both surfaces (admin API and dashboard session) and assert the event,
// its actor attribution, and that the chain still verifies afterwards.

import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE, SESSION_TTL_MS, signToken } from "../src/session";
import { verifyLedgerChain } from "../src/ledger";
import { generateIssuerKeypair } from "../scripts/test-issuer";
import { provisionOrg } from "./helpers";

const ADMIN = "admin@controlplane.test";

let orgId: string;
let adminCookie: string;

const adminFetch = (path: string, body?: Record<string, unknown>) =>
  SELF.fetch(`http://example.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-admin-key": "test-admin-key",
    },
    body: JSON.stringify(body ?? {}),
  });

const dashPost = (path: string, form: Record<string, string>) =>
  SELF.fetch(`http://example.com${path}`, {
    method: "POST",
    headers: {
      cookie: adminCookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form).toString(),
    redirect: "manual",
  });

/** Newest ledger event of a type, payload parsed. */
async function lastEvent(eventType: string) {
  const row = await env.DB.prepare(
    `SELECT request_id, payload_json FROM ledger_events
     WHERE org_id = ? AND event_type = ? ORDER BY seq DESC LIMIT 1`
  )
    .bind(orgId, eventType)
    .first<{ request_id: string; payload_json: string }>();
  return row
    ? { requestId: row.request_id, payload: JSON.parse(row.payload_json) }
    : null;
}

async function countEvents(eventType: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM ledger_events WHERE org_id = ? AND event_type = ?"
  )
    .bind(orgId, eventType)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

beforeAll(async () => {
  const org = await provisionOrg({
    name: "Control Plane Org",
    agentId: "cp-agent",
    approverEmail: ADMIN,
  });
  orgId = org.orgId;
  adminCookie = `${SESSION_COOKIE}=${await signToken("test-session-secret", {
    purpose: "session",
    email: ADMIN,
    orgId,
    exp: Date.now() + SESSION_TTL_MS,
  })}`;
});

describe("org provisioning", () => {
  it("starts the chain with an org_created event", async () => {
    const event = await lastEvent("org_created");
    expect(event).not.toBeNull();
    expect(event!.requestId).toBe("org");
    expect(event!.payload).toMatchObject({
      name: "Control Plane Org",
      createdBy: "admin-api",
      approverEmail: ADMIN,
      agentId: "cp-agent",
    });
    expect(event!.payload.policyVersion).toBe(1);
    expect(String(event!.payload.keyId)).toMatch(/^key_/);
  });
});

describe("agent key lifecycle", () => {
  it("records creation and revocation via the admin API", async () => {
    const created = await adminFetch(`/api/admin/orgs/${orgId}/keys`, {
      agent_id: "cp-second",
    });
    expect(created.status).toBe(200);
    const createdEvent = await lastEvent("agent_key_created");
    expect(createdEvent!.payload).toMatchObject({
      agentId: "cp-second",
      createdBy: "admin-api",
    });

    const keyRow = await env.DB.prepare(
      "SELECT id FROM agent_keys WHERE org_id = ? AND agent_id = 'cp-second'"
    )
      .bind(orgId)
      .first<{ id: string }>();
    const revoked = await adminFetch(
      `/api/admin/orgs/${orgId}/keys/${keyRow!.id}/revoke`
    );
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ ok: true, agent_id: "cp-second" });
    const revokedEvent = await lastEvent("agent_key_revoked");
    expect(revokedEvent!.payload).toMatchObject({
      keyId: keyRow!.id,
      agentId: "cp-second",
      revokedBy: "admin-api",
    });

    // Revoking an already-revoked key is a 404 and appends nothing.
    const before = await countEvents("agent_key_revoked");
    const again = await adminFetch(
      `/api/admin/orgs/${orgId}/keys/${keyRow!.id}/revoke`
    );
    expect(again.status).toBe(404);
    expect(await countEvents("agent_key_revoked")).toBe(before);
  });

  it("records creation and revocation via the dashboard", async () => {
    const created = await dashPost("/dashboard/keys/create", {
      agent_id: "cp-dash",
    });
    expect(created.status).toBe(200);
    const createdEvent = await lastEvent("agent_key_created");
    expect(createdEvent!.payload).toMatchObject({
      agentId: "cp-dash",
      createdBy: ADMIN,
    });

    const keyRow = await env.DB.prepare(
      "SELECT id FROM agent_keys WHERE org_id = ? AND agent_id = 'cp-dash'"
    )
      .bind(orgId)
      .first<{ id: string }>();
    const revoked = await dashPost("/dashboard/keys/revoke", {
      key_id: keyRow!.id,
    });
    expect(revoked.status).toBe(302);
    const revokedEvent = await lastEvent("agent_key_revoked");
    expect(revokedEvent!.payload).toMatchObject({
      keyId: keyRow!.id,
      agentId: "cp-dash",
      revokedBy: ADMIN,
    });
  });
});

describe("membership changes", () => {
  it("records upserts from both surfaces and deletions", async () => {
    await adminFetch(`/api/admin/orgs/${orgId}/members`, {
      email: "Viewer@Controlplane.Test",
      role: "viewer",
    });
    let event = await lastEvent("member_upserted");
    expect(event!.payload).toMatchObject({
      email: "viewer@controlplane.test",
      role: "viewer",
      changedBy: "admin-api",
    });

    // Role change via the dashboard.
    const res = await dashPost("/dashboard/members", {
      email: "viewer@controlplane.test",
      role: "approver",
    });
    expect(res.status).toBe(302);
    event = await lastEvent("member_upserted");
    expect(event!.payload).toMatchObject({
      email: "viewer@controlplane.test",
      role: "approver",
      changedBy: ADMIN,
    });

    const memberId = String(event!.payload.memberId);
    const del = await dashPost("/dashboard/members/delete", {
      member_id: memberId,
    });
    expect(del.status).toBe(302);
    const removed = await lastEvent("member_removed");
    expect(removed!.payload).toMatchObject({
      memberId,
      email: "viewer@controlplane.test",
      role: "approver",
      removedBy: ADMIN,
    });
  });
});

describe("issuer trust-root changes", () => {
  it("records registration (with key thumbprint) and revocation", async () => {
    const keypair = await generateIssuerKeypair("Ed25519");
    const reg = await adminFetch(`/api/admin/orgs/${orgId}/issuers`, {
      issuer: "https://network.controlplane.test",
      scheme: "ap2",
      alg: "Ed25519",
      public_key_jwk: keypair.publicJwk,
    });
    expect(reg.status).toBe(200);
    const { issuer_id: issuerId } = await reg.json<{ issuer_id: string }>();
    const registered = await lastEvent("issuer_registered");
    expect(registered!.payload).toMatchObject({
      issuerId,
      issuer: "https://network.controlplane.test",
      scheme: "ap2",
      alg: "Ed25519",
      registeredBy: "admin-api",
    });
    expect(String(registered!.payload.keyThumbprint)).toMatch(/^[0-9a-f]{16}$/);

    const rev = await adminFetch(
      `/api/admin/orgs/${orgId}/issuers/${issuerId}/revoke`
    );
    expect(rev.status).toBe(200);
    const revoked = await lastEvent("issuer_revoked");
    expect(revoked!.payload).toMatchObject({
      issuerId,
      issuer: "https://network.controlplane.test",
      revokedBy: "admin-api",
    });

    // Revoking again is a no-op: no duplicate event.
    const before = await countEvents("issuer_revoked");
    await adminFetch(`/api/admin/orgs/${orgId}/issuers/${issuerId}/revoke`);
    expect(await countEvents("issuer_revoked")).toBe(before);
  });
});

describe("team changes", () => {
  it("records creation, agent assignment, and approver routing", async () => {
    const res = await adminFetch(`/api/admin/orgs/${orgId}/teams`, {
      name: "cp-team",
      agent_ids: ["cp-agent"],
      approver_emails: [ADMIN],
    });
    expect(res.status).toBe(200);
    const { team_id: teamId } = await res.json<{ team_id: string }>();

    const created = await lastEvent("team_created");
    expect(created!.payload).toMatchObject({
      teamId,
      name: "cp-team",
      createdBy: "admin-api",
    });
    const assigned = await lastEvent("team_agent_assigned");
    expect(assigned!.payload).toMatchObject({
      teamId,
      agentId: "cp-agent",
      action: "add",
      changedBy: "admin-api",
    });
    const approvers = await lastEvent("team_approver_changed");
    expect(approvers!.payload).toMatchObject({
      teamId,
      approvers: [ADMIN],
      changedBy: "admin-api",
    });

    // Removal via the dashboard.
    const removal = await dashPost(`/dashboard/teams/${teamId}/agents`, {
      agent_id: "cp-agent",
      action: "remove",
    });
    expect(removal.status).toBe(302);
    const removed = await lastEvent("team_agent_assigned");
    expect(removed!.payload).toMatchObject({
      teamId,
      agentId: "cp-agent",
      action: "remove",
      changedBy: ADMIN,
    });
  });
});

describe("export egress", () => {
  it("records dashboard exports with the filters that were applied", async () => {
    const res = await SELF.fetch(
      "http://example.com/dashboard/export/purchases.csv?status=approved",
      { headers: { cookie: adminCookie }, redirect: "manual" }
    );
    expect(res.status).toBe(200);
    const event = await lastEvent("export_generated");
    expect(event!.requestId).toBe("export");
    expect(event!.payload).toMatchObject({
      exportType: "purchases.csv",
      by: ADMIN,
      filters: { status: "approved" },
    });
  });

  it("records admin-API exports, and the bundle includes its own export event", async () => {
    const res = await SELF.fetch(
      `http://example.com/api/admin/orgs/${orgId}/export/audit-bundle.json`,
      { headers: { "x-admin-key": "test-admin-key" } }
    );
    expect(res.status).toBe(200);
    const bundle = await res.json<{
      events: Array<{ event_type: string; payload_json: string }>;
    }>();
    const event = await lastEvent("export_generated");
    expect(event!.payload).toMatchObject({
      exportType: "audit-bundle.json",
      by: "admin-api",
    });
    // The event lands before the bundle is built, so the export is
    // self-recording.
    const last = bundle.events.at(-1)!;
    expect(last.event_type).toBe("export_generated");
    expect(JSON.parse(last.payload_json).exportType).toBe("audit-bundle.json");
  });
});

describe("chain integrity", () => {
  it("still verifies end to end after every control-plane mutation", async () => {
    const verification = await verifyLedgerChain(env.DB, orgId);
    expect(verification).toMatchObject({ ok: true });
    // Sanity: all Phase 4 event families are present on this org's chain.
    for (const type of [
      "org_created",
      "agent_key_created",
      "agent_key_revoked",
      "member_upserted",
      "member_removed",
      "issuer_registered",
      "issuer_revoked",
      "team_created",
      "team_agent_assigned",
      "team_approver_changed",
      "export_generated",
    ]) {
      expect(await countEvents(type), type).toBeGreaterThanOrEqual(1);
    }
  });
});
