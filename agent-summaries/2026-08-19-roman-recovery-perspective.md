# Roman's two cents (recovery perspective)

> Companion to Hermes' top-of-file handoff entry on `path-b-publishing-worker`.
> Roman — primary-recovery agent during the 2026-08-18/19 outage. Capturing
> the operational gotchas and the two real bugs I fixed mid-campaign so
> the dedicated agent doesn't have to rediscover them.

## The two real bugs I caught and fixed

### 1. `worker-publishing/src/index.ts`: `Document` interface matches D1 snake_case

D1 returns snake_case columns. The TypeScript interface was camelCase
without a mapping, so `row.headHash` (camelCase) was `undefined` at the
R2-key-construction step. Every read silently 404'd because the worker
tried to read `pages/${slug}/undefined/<docPath>`.

Fixed: `Document` in `worker-publishing/src/index.ts` uses `workspace_id`,
`doc_path`, `head_hash`, `created_at`, `updated_at`, `deleted_at`. The
API contract (`DocumentResponse`) stays camelCase since it crosses the
wire. The TypeScript interfaces aren't a 1:1 match.

**Symptom that surfaced:** the 12 published manifests were visible at
their p... misroute from D1. Mistake was on the read side, not the
write side.

### 2. `scripts/migrate-to-palapa.ts`: hash check was over-strict

The original migration script failed all 65 entries because the local
registry from upstream `@plannotator/tot` had neither `contentHash`
nor `docSha256` populated — they were internal to the upstream
Workspaces API, not persisted to the local `~/.tot`. A strict
"hash must match manifest" check failed every entry as a "hash mismatch".

Fixed: when no manifest hash is present, **warn-and-proceed** (the
worker re-verifies server-side on read). When a manifest hash is
present, the check is still enforced. This matches the upstream helper
contract.

**Operational note:** an entry that has a manifest hash, AND the
on-disk file's hash disagrees, MUST fail loudly. Don't weaken the
strict check on entries that have a manifest hash.

## Operational gotchas for the dedicated agent

### `npx wrangler d1 execute ...` defaults to local

`--remote` is mandatory for the live `palapala-registry` database.
Without it, wrangler tries to apply the SQL to a local development
database that **doesn't exist for this Worker** — you'd see errors
like "could not find D1 database palapala-registry" or
"file:./.wrangler/state". Always pass `--remote` for this Worker.

### Cloudflare OAuth tokens expire

The `CLOUDFLARE_API_KEY` (cfat_...) token that worked yesterday may
return `{"code":1000,"message":"Invalid API Token"}` today. Tokens
rotate; the right fix is to regenerate in
dash.cloudflare.com → My Profile → API Tokens → Create Token.
**Don't store the token in a file that gets committed.** The
`soderalohastrom/tot` repo's `.gitignore` should exclude `.env` files.

### Dashboard Worker bundle may go stale

The dashboard Worker (`tot-dashboard`) is a separate Worker from
`palapala-publisher`. **The bulk-import script PUTs the manifest
to the dashboard Worker**, not the publishing Worker. They're
different `wrangler.jsonc` files. If you only deploy one of them,
the manifest doesn't reach the right place.

The dashboard worker is at `wrangler.jsonc` (root) and the
publishing worker is at `wrangler-publishing.jsonc`. They share
the same Cloudflare account but deploy to different Worker names.

### Manifest regression: 59 → 17

If the manifest count drops from ~12 to ~17 (or other lower numbers)
on `palapala.me/scotty`, the manifest PUT probably failed. The
buffer is 60s on `/api/tots?project=scotty` edge cache — refresh
after a minute to see the new count. Earlier I caught a regression
where the manifest published 12 entries but the count in the
dashboard rendered 17 (using stale cache). Re-running the bulk-import
refreshed it.

## Tools I left at /tmp for measuring improvement

These are durable artifacts the next agent can re-run:

- `/tmp/roman-deadends-compare.py` — multi-surface hit-checker
  (5 surfaces: Path B docPath / Path B index.html / Path A
  mirror / dashboard iframe / upstream tot.page). Output format
  is one row per slug with status codes per surface.
- `/tmp/roman-deadends-diff.py` — diff two snapshots of the
  above output. Trending improvement.
- `/tmp/deadends-before-import.json` — baseline snapshot (53/65
  Path B deadends, 65/65 Path A deadends, 65/65 upstream).
- `/tmp/deadends-pala-after-import.json` — post-12-import snapshot.
  Used these to verify the bulk-import actually moved the needle.

## Lead-in protocol for the dedicated LLM

When you wake up, if you don't know Scotty's voice:

- Roman = OpenClaw on Mac (Claude Sonnet), lives on
  `~/clawd/`, async partner for the long council
- Hermes = wolfpack coordinator, async, may not be in the
  shared channels; cc'able via herdr pane ID when needed
- Vox = the dedicated agent (you) — sits in the middle of
  this codebase, owns the daily commit/PR cycle
- Scotty = human owner, signs off on Pal-directory and Hunt
  clause changes (Phase 0 decisions)

Vocabulary: **`pala` = the rebrand's published file**. `tot` is
the legacy upstream shorthand. Slugs are durable. docPath is the
source file's path inside the doc; the worker stores it under
`index.html` (pre-fix) or the actual docPath (post-fix in
`worker-publishing/src/index.ts`).

## Day-2 wishlist (things for the next agent to pick up)

1. **Commit Hermes' uncommitted docPath support.** The fix from
   `worker-publishing/src/index.ts` that stops hardcoding
   `doc_path = "index.html"` is in the working tree but isn't
   committed. After committing, re-publish the 53 source
   files (one at a time, as Scotty has them) and they will
   land at `docs.palapala.me/<slug>/<actual-docPath>.html`.
2. **Redeploy the tot-dashboard Worker.** The bundle that
   serves the `/api/tots` and `/api/sync/manifest` endpoints
   on `palapala.me` is the dashboard Worker. If the Ed25519
   version drift is off, re-run `pnpm cloud:deploy`.
3. **Restore the 65-entry manifest.** After Scotty wants the
   53 re-published, run `pnpm import:bulk` with the
   `DASHBOARD_SYNC_TOKEN` from the Keychain. The 53 placeholder
   URLs will be replaced with real `https://docs.palapala.me/<slug>/<docPath>`
   once the bytes land.
4. **Fix the local-mirror route** to take `/{slug}/{docPath}` so
   the iframe's `localUrl` matches the worker's read shape
   `/{slug}/{docPath}`. Today's route only matches `/{slug}`.

## Sign-off

Hermes ran the operator portion of the campaign end-to-end:
ran the `pnpm import:bulk` with the right DASHBOARD_SYNC_TOKEN,
got the manifest PUT to 200, batched the schema validations, and
documented the gotchas. I ran the recovery portion: caught the D1
snake_case bug, fixed the migration hash check, staged the
deadends baseline, and verified the 12-entry manifest landed on
`palapala.me/scotty` end-to-end with hash-match confirmed.

Welcome off the hamster wheel, brother. The fork has graduated.

— Roman 🤙🏼🐺🌺

---

## 2026-08-18 — Tot → Pala rebrand (cosmetic PR; Path A)

**Status:** Path A shipped as one commit on `main`. Path B (publishing Worker
against R2 + D1, cutover from `tot.page`) is held until the morning call.
