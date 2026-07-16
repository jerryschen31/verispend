# VeriSpend

**Spend verification for AI agents.** A drop-in MCP server your agents call *before* spending money — policy check, human escalation, and an immutable audit ledger — plus a dashboard where finance reviews and approves. VeriSpend never moves money: agents pay on whatever rail they already use, and VeriSpend is the control plane a CFO can trust.

## How it works

1. An agent that wants to buy something calls the `request_purchase` MCP tool with vendor, amount, category, and justification.
2. VeriSpend evaluates the org's versioned spend policy (caps, category/vendor rules, per-agent and org budgets) and returns `approved`, `denied`, or `pending_approval`.
3. Escalated purchases email the approver a one-click approve/deny link and appear in the dashboard queue; the agent polls `check_approval`.
4. After paying, the agent calls `record_outcome` — the final charge is recorded against the approval and budget counters are corrected.
5. Every step is an append-only, hash-chained ledger event. The dashboard's Audit page re-verifies the whole chain on demand.

Two Phase-1 safeguards run on top of that flow:

- **Circuit breaker** — every `request_purchase` is pattern-checked (identical-request loops, request velocity, spend acceleration vs the agent's trailing baseline). A trip freezes the agent: all further purchases are denied, the approver is emailed, and a `breaker_tripped` event lands on the ledger. Unfreezing is one click in the dashboard. Thresholds are per-org policy (`circuitBreaker`), on by default.
- **Metered-usage reconciliation** — agents report pay-per-use consumption with `record_usage` (it counts against budgets), finance enters the provider's bill on the Reconciliation page (or via API), and VeriSpend flags bills that don't match the recorded usage (`overbilled`, `underbilled`, `no_usage_data`; tolerance via policy `reconciliation`).

Phase 3 adds the cross-rail plane — all of it consume-only, with zero calls to any payment platform:

- **Payment mandates** — an agent can present a network-issued credential (compact JWS: Google AP2, Visa Verified Agent ID, Stripe-token shaped) with `request_purchase`. VeriSpend verifies it locally against public keys the org registered on the Issuers page (that registration *is* the integration), checks scope (vendor, category, amount, currency) and validity window, and records verified and rejected presentations on the ledger. Policy `mandates.require` can deny purchases lacking a verified mandate. A presented-but-invalid credential is always a hard deny.
- **Cross-rail settlements** — rails and finance systems push settlement confirmations (card record, stablecoin tx, checkout receipt, Stripe-event JSON) to the Settlements page or `POST /api/admin/orgs/:id/settlements`. Each is matched to its purchase in three tiers: the `settlement_ref` the agent reported at `record_outcome`, our `approval_ref` echoed back by the rail, then a vendor/amount/time heuristic. Over-charges flag `amount_mismatch`; a charge no agent ever requested flags `unauthorized` and alerts approvers.
- **Verifiable receipts** — any decided purchase (denials too) can be attested with an Ed25519-signed receipt covering the request, decision, mandate, outcome, and settlement match, with ledger-hash anchors tying it into the tamper-evident chain. Verify offline with `node scripts/verify-receipt.ts receipt.json [bundle.json]` — no VeriSpend code, no network. Signing keys are published at `/.well-known/verispend-keys.json`. See `docs/receipt-verification.md`.

## MCP tools

| Tool | Purpose |
|------|---------|
| `request_purchase` | Ask for authorization before paying |
| `check_approval` | Poll a pending human decision |
| `record_outcome` | Report the final charge after purchase |
| `record_usage` | Report metered consumption (tokens, compute) after the fact |
| `get_budget_status` | Remaining agent/org budgets + frozen state |
| `get_receipt` | Fetch (or issue) the signed verifiable receipt for a decided purchase |

`request_purchase` accepts an optional `mandate` (compact JWS credential); `record_outcome` accepts optional `rail` + `settlement_ref` so the rail's settlement record matches the purchase exactly.

Agents authenticate with a per-agent bearer key (`Authorization: Bearer vs_...`) against `https://<host>/mcp` (Streamable HTTP). Agent identity comes from the key — it can't be spoofed via tool arguments.

## Development

```sh
npm install
npx wrangler d1 migrations apply verispend --local
npm run dev          # http://localhost:8787
npm test             # vitest (workers pool)
npm run check        # typecheck
npm run simulate     # 4-agent demo/E2E against the dev server (see below)
```

### Agent simulator

With `npm run dev` running, `npm run simulate` provisions a fresh demo org and
drives eleven scenarios through the real MCP endpoint: a well-behaved buyer, a
runaway loop that trips the circuit breaker, a metered agent whose provider
over-bills it, a prompt-injected agent contained by the deny-list and the
velocity breaker, team budget races, approval routing, explainability, audit
export, a mandated agent presenting (and forging) signed credentials, a
cross-rail settlement feed with an over-charge and an unauthorized charge,
and a verifiable receipt re-verified with zero VeriSpend code. It prints a
narrated report and exits non-zero if any expectation fails. Pass
`--approver you@example.com` to make the demo org's dashboard accessible to
your login. Everything runs locally — the "payment network" is a keypair the
simulator generates in-process.

Provision a local org (admin key is in `.dev.vars`):

```sh
curl -X POST http://localhost:8787/api/admin/orgs \
  -H "content-type: application/json" -H "x-admin-key: dev-admin-key" \
  -d '{"name":"Demo Corp","agent_id":"my-agent","approver_email":"you@example.com"}'
```

The response contains the agent's API key (shown once). Connect any MCP client to `http://localhost:8787/mcp` with that bearer key.

Dashboard: `http://localhost:8787/dashboard` — sign-in is Kinde OIDC (hosted login; Kinde sends its own auth emails). Access requires your email to match an org's `approver_email`. Local dev needs `KINDE_CLIENT_SECRET` in `.dev.vars`; `KINDE_DOMAIN`/`KINDE_CLIENT_ID` live in `wrangler.jsonc` vars.

Receipt signing needs `RECEIPT_SIGNING_KEY` in `.dev.vars` — an Ed25519 private JWK on one line; generate one with `node scripts/test-issuer.ts --keygen` and paste the `privateJwk` value.

## Architecture

- **Cloudflare Workers** — Hono app: MCP endpoint, approval links, server-rendered dashboard (Hono JSX, no build step)
- **`McpAgent`** (Agents SDK) — MCP server over Streamable HTTP; auth happens in the Worker, identity flows in via `ctx.props`
- **D1** — orgs, agent keys (hashed), versioned policies, purchase requests, hash-chained `ledger_events`
- **Durable Object per org** (`OrgCoordinator`) — atomic budget counters and serialized ledger appends (prevents chain forks)
- **Kinde (OIDC)** — dashboard login; no SDK, plain authorization-code flow
- **Email Service** — approval notification emails (best-effort; requires Workers Paid + domain onboarding)

## Deploy

```sh
npx wrangler login
npx wrangler d1 create verispend            # put the id in wrangler.jsonc
npx wrangler d1 migrations apply verispend --remote
npx wrangler secret put ADMIN_KEY
npx wrangler secret put SESSION_SECRET
npx wrangler secret put KINDE_CLIENT_SECRET
node scripts/test-issuer.ts --keygen        # privateJwk → RECEIPT_SIGNING_KEY
npx wrangler secret put RECEIPT_SIGNING_KEY
npx wrangler email sending enable verispend.com   # requires Workers Paid plan
npm run deploy
```

Set `BASE_URL` in `wrangler.jsonc` vars to the deployed URL.
