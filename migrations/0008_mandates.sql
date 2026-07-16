-- Payment mandates (Phase 3): externally issued, signed permission slips an
-- agent can present with a purchase. VeriSpend never issues mandates — it
-- verifies ones presented to it against a per-org registry of trusted issuer
-- public keys. Registering a real network's published key (Google AP2, Visa
-- VAI, Stripe) is the only step between simulated and live credentials.

CREATE TABLE mandate_issuers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  issuer TEXT NOT NULL,               -- must equal the mandate's "iss" claim
  scheme TEXT NOT NULL CHECK (scheme IN ('ap2', 'visa_vai', 'stripe_token', 'generic')),
  alg TEXT NOT NULL CHECK (alg IN ('Ed25519', 'ES256')),
  public_key_jwk TEXT NOT NULL,       -- JSON JWK, public part only
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,
  UNIQUE (org_id, issuer)
);
CREATE INDEX idx_mandate_issuers_org ON mandate_issuers(org_id);

-- One row per mandate presented with a purchase request, verified or not —
-- a rejected credential is evidence too. The raw token is kept verbatim.
-- token_hash is deliberately not unique: one mandate may cover several
-- purchases within its scope window.
CREATE TABLE payment_mandates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  request_id TEXT NOT NULL REFERENCES purchase_requests(id),
  issuer_id TEXT REFERENCES mandate_issuers(id),  -- NULL when the issuer is unknown
  scheme TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,              -- the agent identity per the network ("sub")
  mandate_ref TEXT NOT NULL,          -- the mandate's own id ("jti")
  scope_json TEXT NOT NULL,           -- normalized MandateScope
  not_before TEXT,
  expires_at TEXT,
  token_hash TEXT NOT NULL,
  raw_token TEXT NOT NULL,
  verification_status TEXT NOT NULL CHECK (verification_status IN
    ('verified', 'invalid', 'expired', 'scope_violation', 'issuer_unknown')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_mandates_org_request ON payment_mandates(org_id, request_id);
