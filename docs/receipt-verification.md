# Verifying a VeriSpend receipt (for auditors and counterparties)

A VeriSpend **verifiable receipt** is a signed JSON artifact proving that a
specific agent purchase was authorized, by whom, under what policy and
mandate, and how it matched the charge that actually settled. It is designed
to be verified **without trusting VeriSpend**: no VeriSpend code, no network
access, no account.

## What's inside

```jsonc
{
  "format": "verispend-receipt",
  "version": 1,
  "receipt_id": "rcpt_…",
  "issued_at": "…",
  "payload_json": "…",          // the signed claims, verbatim
  "signature": {
    "alg": "Ed25519",
    "key_id": "…",               // thumbprint of the public key
    "public_key_jwk": { … },     // the verification key itself
    "sig": "…"                   // base64url over payload_json's UTF-8 bytes
  },
  "verification_recipe": { "instructions": "…" }
}
```

`payload_json` parses to the claims: the request (vendor, amount, category,
justification), the decision (status, rule fired, policy version, approver),
the payment mandate presented (issuer, scope, verification status), the
recorded outcome, the matched settlement (rail, reference, variance), and a
`ledger_anchor` — the hashes of every ledger event about this purchase plus
the org's chain head at issuance.

## Verify it

With Node ≥ 22 and the two scripts in `scripts/` (which import nothing from
the VeriSpend codebase):

```sh
# 1. Signature + key thumbprint + envelope consistency
node scripts/verify-receipt.ts receipt.json

# 2. Optionally: prove the receipt's claims are the same ones in the
#    org's tamper-evident ledger
node scripts/verify-bundle.ts bundle.json            # bundle self-verifies
node scripts/verify-receipt.ts receipt.json bundle.json   # anchors cross-check
```

Exit code 0 means verified; 1 means tampered or inconsistent, with the reason
printed. `bundle.json` is the org's audit bundle (dashboard → Export →
audit-bundle.json).

Manual verification (any WebCrypto runtime) follows the embedded recipe:
import `signature.public_key_jwk` as an Ed25519 key, verify `signature.sig`
over the exact UTF-8 bytes of `payload_json`, and recompute `key_id` as the
first 16 hex chars of SHA-256 over `{"crv":…,"kty":…,"x":…}`.

## Trust anchors

- **Key authenticity** — check `signature.key_id` against the keys the
  VeriSpend instance publishes at `GET /.well-known/verispend-keys.json`
  (current signing key plus every key that ever signed a stored receipt, so
  rotation never orphans an old receipt).
- **Claim integrity** — every hash in `ledger_anchor` must appear, unaltered,
  in the org's audit bundle; the bundle's own hash chain is re-verifiable
  from genesis with `verify-bundle.ts`. Altering any past ledger entry breaks
  the chain at that exact sequence number.

## What a receipt is good for

Dispute evidence. "This charge exceeded the agent's authority" (a denied
request's receipt proves no authorization existed), "we were billed more than
was authorized" (`settlement.variance_cents` and `match_status` show the
gap), or the affirmative case: this purchase was inside policy, inside the
mandate's scope, approved by this person, and settled for exactly what was
authorized. VeriSpend supplies the proof; it never moves or reverses funds.
