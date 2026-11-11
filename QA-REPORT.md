# CafeTrack QA Report

`/gstack-qa` isn't installed on this OpenCode instance, so QA was run directly (static checks + the repo's own test scripts) against the working tree at `C:\Users\ZEPHYRUS\Pictures\cafetrack main`.

Note: the tree already had **138 modified files** vs `HEAD` (large UI/API rework: checkout, reports, dashboard, items, users, alerts, face/ID verification, SFace, duty roster, email, backups). My QA edits are only to 3 test files; no source files were changed by me.

## Static checks

| Check | Result |
|---|---|
| `tsc --noEmit` | CLEAN (no errors) |
| `eslint src --ext .ts,.tsx` | CLEAN (no errors) |

## Pure (no-server) test suites — all pass

These run via `node` directly, no dev server needed:

| Suite | Result |
|---|---|
| `_face-blink-tests.mjs` | 4 passed |
| `_rate-limit-tests.mjs` | 3 passed |
| `_report-pdf-tests.mjs` | passed (7 pages) |
| `_duty-roster-tests.mjs` | passed (after fix below) |
| `_face-math.mjs` | 171 passed |
| `_id-name-tests.mjs` | 37 passed |
| `_id-forgery-tests.mjs` | 63 passed |
| `_ocr-tests.mjs` | 74 passed |
| `_head-pose-tests.mjs` | 96 passed |
| `_face-image.mjs` | 38 passed |
| `_face-diagnostics.mjs` | 28 passed |
| `_face-sface-tests.mjs` | 44 passed |
| `_ocr-space-tests.mjs` | passed |
| `_id-card-distance-tests.mjs` | passed |
| `_step2-ticket-tests.mjs` | 24 passed |

## Server-based suites (against `npm run dev:test` on port 3101, throwaway `.pglite-test` DB)

| Suite | Result |
|---|---|
| `smoke-test.mjs` | **89 passed, 0 failed** (after fix below) |
| `_edge-tests.mjs` | **166 passed, 1 failed** — remaining failure is a behavior question (below) |

## Bugs found and fixed (all in test contracts, not application source)

The application source behaved per its contract; the tests were out of sync with it.

1. **`scripts/_duty-roster-tests.mjs` — crash on missing field.** `buildDutyRoster()` requires `faceResetEvents` in its input type (`src/lib/duty-roster.ts:68`), and the production route passes it (`resetResult.rows ?? []`), but both test calls omitted it, so `input.faceResetEvents` was `undefined` and `for (const reset of input.faceResetEvents)` threw `TypeError: ... is not iterable`.
   - Fix: added `faceResetEvents: [],` to both test calls. Suite now passes.

2. **`scripts/smoke-test.mjs` — alert resolve missing `reason`.** `PATCH /api/alerts/:id` with `{ resolved: true }` returned 400 ("Add a reason before resolving this alert") because `src/app/api/alerts/[id]/route.ts:159-161` requires a `reason` to resolve, and the frontend sends one (`alerts/page.tsx:288-291`). The test omitted it.
   - Fix: `{ resolved: true, reason: "smoke test resolved" }`. Smoke now 89/0.

3. **`scripts/_edge-tests.mjs` — alert resolve missing `reason`** (same as #2, two call sites).
   - Fix: added `reason: "edge test resolved"` and `reason: "edge test resolved again"`. Edge now 166 passed / 1 failed.

## Remaining open item (behavior to confirm, not changed)

**`_edge-tests.mjs` — "deactivated staff cannot transact (403)" actually returns `401 Not signed in`.**
- `src/lib/auth.ts:238-239` requires `row.is_active !== false` for a valid session, and the comment at `auth.ts:148` says deactivation "is felt almost immediately". So deactivation revokes the live session → next request is 401.
- The test asserts 403 (session survives, action blocked).
- This is a product-design question: is instant session revocation on deactivation intended (then the test expectation is wrong), or should a live session survive with mutations refused 403 (then the `is_active` check is over-broad)? I did not change either side; confirm intent before editing.

## Files I changed

- `scripts/_duty-roster-tests.mjs` — added `faceResetEvents: [],` ×2
- `scripts/smoke-test.mjs` — added `reason` to alert-resolve PATCH
- `scripts/_edge-tests.mjs` — added `reason` to 2 alert-resolve PATCHes

## Summary

Static checks clean. 14 pure suites + smoke all pass. Edge passes 166/1 with the single failure being the deactivation-semantics question above. Three test-contract bugs were found and fixed; no source-code defects were found in the areas exercised.
