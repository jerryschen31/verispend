# PR #3 review — Phase 3: cross-rail reconciliation and verifiable receipts

2026-07-16, mode: fix

Copilot produced three inline comments.

---

(src/mcp.ts:541) The late-match path in `record_outcome` allows an agent to
re-point any existing settlement with the same `(rail, settlement_ref)` even
if it was already matched to a different purchase. That makes it possible to
overwrite a previously correct match — or "claim" an unauthorized charge —
just by reporting its reference.

**fixed** (73d5df8)
The late-match pass now only rematches a settlement whose `matched_request_id`
is currently `NULL`. A settlement already bound to another purchase (via
exact ref, approval-ref, or heuristic match) is left untouched; reassigning an
existing match is left to an admin flow rather than any authenticated agent.
Added `test/settlements.test.ts` › "refuses to rematch a settlement already
bound to a different purchase": purchase A claims a settlement via its
`settlement_ref`, then purchase B reports the identical ref and is asserted to
leave the settlement's `matched_request_id` and ledger untouched (no spurious
`settlement_matched` rematch event).

---

(src/mandate.ts:100) Mandate claim strings are validated with `v.trim()` but
returned untrimmed. This can preserve leading/trailing whitespace in
`iss`/`sub`/`jti`/`currency` values, causing trusted-issuer lookups (and later
auditing) to fail unexpectedly despite passing the "non-empty" check.

**fixed** (73d5df8)
`str()` now returns `v.trim()` instead of the untrimmed value, matching the
normalization convention already used elsewhere (e.g. `src/settlements.ts`).
Added `test/mandate.test.ts` › "trims whitespace-padded claims before storing
or reporting them": a mandate with padded `iss`/`sub`/`jti` claims is verified
and the returned `presentation` fields are asserted to be exactly the trimmed
values, not the padded originals.

---

(src/export.ts:161) `exportSettlementsCsv` selects all columns (including
`raw_json`) even though the CSV only emits a subset. Because `raw_json` can be
large, this inflates memory/CPU for exports unnecessarily.

**fixed** (73d5df8)
The query now selects only the emitted column list instead of `SELECT *`, so
`raw_json` is never pulled into the export path. Added a case in
`test/exports.test.ts` › "exports settlements.csv with rail and match
filters": ingests a settlement carrying a large `raw_json` sentinel and
asserts it never appears in the CSV output, plus asserts every emitted field
for that row still round-trips correctly (guarding against a column-name typo
in the new explicit `SELECT` list).

---

Verification: `npm run check` clean; `npm test` 174/174 pass (was 172, +2 for
the new settlement-hijack and mandate-trim regression tests; the export test
extended an existing case rather than adding a new `it`). Pushed to
`mvp/phase3` at 73d5df8.
