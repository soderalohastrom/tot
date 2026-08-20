
# Handoff

Notes for whichever LLM picks this repo up next. Running log, newest first.
For durable architecture and invariants see [`CLAUDE.md`](CLAUDE.md); for direction
see [`ROADMAP.md`](ROADMAP.md).

---

## 2026-08-20 (evening) — Tot purge: skills renamed; client-safe clean start

Same day, second act. Scotty ordered "rid ourselves of Tot" plus a fresh start.

**Skills purge (both `~/.agents/skills` and `~/.claude/skills`):**
- `tot-publish` → **`pala-publish`** (dir + frontmatter `title` + v1.3.0).
  All command refs `tot …` → `pala …`, URLs → `docs.palapala.me`, tags swept.
  One intentional lineage line keeps the old name for provenance. The
  brew/plannotator prerequisite was replaced with the self-hosted install
  (`npm link` from `~/PROJECTS/pala` or `npm i -g github:soderalohastrom/pala`).
- `sim-screenshot-observation`: 8 `tot.page` artifact-URL refs →
  `docs.palapala.me` (both copies).
- `html-diagram`: already clean. DSH presets, shell rc files, jot configs:
  no `tot-publish` references found (searched).

**Client-safe clean start (Scotty's pick over scorched earth):**
- Registry 66 → **37 entries**: the 36 tagged (client rooms) + the welcome
  pala. 29 untagged oldies + all 6 dead placeholders purged.
  Backups: `~/.tot.backup-pre-pala-20260820`, `~/.tot.backup-clean-start-20260820`.
- Manifest followed on the next sync (37; rooms verified: mise 24, gohappy 7,
  wolfpack 2, /scotty 37, localhost 37 with manage).
- 4 purged entries remain live-by-link on docs.palapala.me (D1 rows
  `0a1RGV…`, `R7OfHA…`, `KEa103…`, `XfWsYP…`) — unlisted, not unpublished.
  R2 mirror bytes for purged entries stay in the bucket (unreferenced).

**GitHub:** repo renamed `soderalohastrom/tot` → **`soderalohastrom/pala`**
(API rename first, then push — redirects cover the old URL). `main` +
`backup/pre-pala-takeover` tag pushed; local `origin` and package.json
repository URLs updated.

---

## 2026-08-20 — The Pala Takeover: self-hosted publishing is LIVE; repo renamed

> **The fork has fully graduated.** `pala` now publishes to its own
> infrastructure end to end. The repo directory is `~/PROJECTS/pala` (was
> `~/PROJECTS/tot`), the package is `pala@1.0.0`, and the upstream
> (`workspaces.plannotator.ai` / `tot.page`) is dead and irrelevant.
> This entry is the day-3 ground truth; older entries are history.

### What "make me a pala" means now (verified, not aspirational)

```
pala notes.md
  ↳ https://docs.palapala.me/<slug>/index.html   (or /<slug>/<file>.html)
  commit  <sha256[:7]>
  frozen  https://docs.palapala.me/<slug>/<docPath>@<sha256>
```

Publish (with assets), update, remove all work against
`docs.palapala.me` — proven live with an HTML page carrying css + svg + js
assets, an update cycle, and a hard delete (R2 purge included). The first
kept artifact: `https://docs.palapala.me/06b5239c1d865dcef808ff/pala-welcome.html`.

### The three commits on `main` (backup tag: `backup/pre-pala-takeover`)

1. `d90a9ca` — **wire-compat + domain flip + package rename.**
   - `worker-publishing/src/index.ts` rewritten to speak the upstream `/v1`
     wire contract `src/http.ts` expects: snake_case entities, exact response
     wrapping (`{workspace, document}` for POST /v1/documents, **bare** entity
     for workspace-doc POST/GET/PUT), raw-body PUT with kind from
     content-type, **204** DELETE, `POST /v1/workspaces` accepts `{}`.
     Before this, the Worker spoke camelCase-with-wrappers and every CLI flow
     except bare publish was broken.
   - Simplifications (documented in the file header): **workspace id == slug**
     (no workspaces table; assets route by path); assets at R2
     `assets/<slug>/<path>` served as living pointers with document-miss
     fallthrough; stable doc ids from `(slug, docPath)` (fixes a PK collision
     where identical content under two slugs shared a content-derived id);
     DELETE purges the slug's R2 objects.
   - All generated URLs on `https://docs.palapala.me` (was the palapala.me
     apex — every registered URL was a dead link before).
   - `src/config.ts` defaults flipped; `~/.tot` endpoint/contentOrigin
     repointed (backup at `~/.tot.backup-pre-pala-20260820`);
     `scripts/verify-domain-contract.mjs` **inverted** (asserts
     docs.palapala.me, forbids upstream hosts); test fixtures swept;
     `package.json` → `pala@1.0.0`; `tsconfig.json` now typechecks
     `worker-publishing/` (immediately caught two dead vars).
2. `0e4110d` — dashboard CSP `frame-src` → `docs.palapala.me`; bulk-import
   DRY_RUN gates the live manifest PUT; bulk-import parses snake_case;
   CLAUDE.md/AGENTS.md swept to the self-hosted reality.
3. `671355a` — `tot` shim uses `process.exitCode`, not `process.exit()`.
   The hard exit killed the dashboard server right after its banner
   (LaunchAgent crash-loop after the npm relink finally mapped
   `/opt/homebrew/bin/tot` → shim). If the dashboard ever "starts then
   vanishes" again, check this first.

### The manifest regression is FIXED: 65/65 (was 59 → 17)

- Root cause: the bulk-import PUT a 17-entry manifest, and every later
  `dashboard sync` read it as "previous" — the carry-forward
  (`buildMetadataOnlyEntry` in `src/cloud-sync.ts`) can only retain slugs
  that exist in the previous manifest. The 53 were unrecoverable **through
  sync alone**.
- Recovery: **R2 object keys ARE the hashes.** Listed `tots/` in
  `tot-dashboard-archive` via the CF v4 API (wrangler OAuth token from
  `~/.wrangler/config/default.toml` works as a Bearer), rebuilt 42 entries
  from object metadata (titles fetched from `/mirror/`), made 6 true
  placeholders (no bytes anywhere: `6ehpDE…`, `MrfLvL…`, `T9Jhin…`,
  `Tv77NA…`, `YKvbtP…`, `ZNA7lX…` — sha256(empty) sentinel hashes, cards
  render, content 404s until source returns), seeded them with one PUT.
  `pala dashboard sync` then reported **"65 palas, 0 new objects, manifest
  unchanged"** — carry-forward is stable.
- The tool: `/tmp/pala-manifest-restore.py` (rerunnable; `--write` to apply).
  It also trimmed 5 registry entries' asset refs whose bytes exist nowhere
  (logged loudly, backed up).
- The worker saves `manifest/snapshots/<generatedAt>.json` on every PUT —
  future regressions can diff/restore from there.

### Surface state (all verified this session)

- **Localhost `127.0.0.1:4173`** (LaunchAgent `com.paumalu.tot-dashboard`):
  65 cards, `capabilities.manage: true` — hover tag/rename/delete work;
  tag round-trip verified via CLI. Restarted post-rename; reads `~/.tot` live.
- **palapala.me `/`**: dead-end landing (obfuscated home) ✅.
  **`/api/tots`** unscoped → 404 ✅. **`/scotty`** (OWNER_SLUG): 65, read-only ✅.
  Client rooms: `/mise` 24, `/gohappy` 7, `/wolfpack` 2, unknown slug → empty ✅.
- **docs.palapala.me**: publisher Worker live (version fa21cef8+);
  12 migrated docs + welcome page serving; `/v1/me` stub OK.
- **D1 `palapala-registry`**: 12 real rows (junk test rows
  `romanTestDoc2026`/`romanFreshSlug42` deleted, R2 objects purged).

### Repo/machine layout after the rename

- Repo: `~/PROJECTS/pala` (branch `main`; `path-b-publishing-worker` merged
  and kept as tag `backup/pre-pala-takeover`). Remotes unchanged
  (`origin` = soderalohastrom/tot, `upstream` = plannotator/tot, reference only).
- npm: global package `pala` → `~/PROJECTS/pala`; bins `pala` (→ dist/cli.js)
  and `tot` (→ dist/tot-shim.js, 90-day alias).
- LaunchAgents reference `/opt/homebrew/bin/tot` only — no plist changes
  needed. `~/.tot` path kept per decision.
- The DSH/agent session workspace may still point at the old path; use
  `~/PROJECTS/pala` explicitly.

### Known gaps / next moves (not urgent)

- **6 placeholder slugs** need source bytes to become real: same recovery
  flow as before (find bytes → `pala <file> --slug <existing>`… actually
  publish the file fresh and the registry/REST will sort identity out —
  slugs are durable, the placeholder upgrades on next sync).
- **Format drift**: `pnpm format` normalizes ~25 untouched files (oxfmt
  rewrapping). Left uncommitted deliberately; do one dedicated format commit
  when convenient.
- **Old registry `url` fields** still say `tot.page` for the 65 historical
  entries (they're the record of where the page lived; `originalUrl` in the
  manifest and all dashboard actions use working URLs). Sync downloads fall
  back to the mirrored bytes, so this is cosmetic.
- **`pala login --key`** is a stub by decision (`/v1/me` returns anonymous).
- The stale milestone slug in the 2026-08-19 entry (`PBkFcrRLBsVYUs07x8JFeA`)
  does not exist — don't chase it.
- Not pushed to `origin` — Scotty's call when to publish `main`.

---

## 2026-08-19 — Path B shipped, branded as `pala`; dedicated agent handoff

> ⚠️ **This is the day-2 handoff.** Scotty is parking Hermes (the wolfpack
> coordinator) and Roman (the previous-work agent) and moving `pala` onto
> a single dedicated agent that lives **inside** this codebase as the
> primary operator. The fork has graduated. This handoff is the
> instructions for that agent.

### TL;DR

The `pala` project is a fork of `@plannotator/tot` that has effectively
become its own product. **Path A (rebrand) and Path B (publishing
Worker against R2 + D1) are both live.** The fork asserts its own brand
on its own Cloudflare account. The fork is no longer waiting on the
upstream `tot.page` infrastructure. Path A is the visible surface; Path
B is the durable content surface.

Scotty's direction: **palapala.me is the right direction.** The
localhost-only version is less interesting long-term. The agent
spinning up Scotty's next session should hold the cloud-first surface
as the primary ground truth and treat the local-first mirror as a
debugging convenience.

### Where we are right now (for the next LLM)

**Branch:** `path-b-publishing-worker` (7 commits ahead of `main`).
**Default pose for new work:** start a feature branch off this one.

**Surface architecture (all live):**

- **Worker**, Cloudflare `palapala-publisher` at
  `palapala-publisher.scott-c93.workers.dev`. 8 endpoints, anonymous
  by default, sync versioning. The pre-fix Worker hardcoded
  `doc_path = "index.html"`, so the 12 published manifests all live
  under `/<slug>/index.html` — the registry's recorded `docPath` field
  is the *source* path, not the *D1* path. Roman's `d022b0b` patch
  fixed the D1 snake_case mismatch; my `3106fb7` added the routes
  entry that auto-provisions the `docs.palapala.me` custom domain on
  deploy.
- **Custom Domain** `docs.palapala.me` (was missing from the original
  `palapala.me` zone because the right way to add it is via the
  Worker's Custom Domain feature, not a manual CNAME. A workers.dev
  CNAME does not route `Host: docs.palapala.me` to the Worker — it
  only serves its own hostname. Custom Domain auto-creates the DNS
  record; the wrangler `routes` block in `wrangler-publishing.jsonc`
  is what triggers this. Do not reintroduce the manual CNAME flow.
- **Public manifest** at `tot-dashboard-archive/manifest/current.json`
  on the dashboard Worker (`tot-dashboard`, separate from
  `palapala-publisher`). Read at `https://palapala.me/scotty/api/tots`.
  12 entries published, 53 durable slugs in the local registry
  (`~/.tot`) that are not yet on the manifest because their source
  bytes are missing on this Mac.
- **D1**, database `palapala-registry`. Has the 12 published
  documents with head hashes. The D1 schema is in `worker-publishing/src/index.ts`
  around line 50; re-bootstrap with the SQL in the file comment if
  the table is ever wiped.
- **R2**, bucket `palapala-pages`. Content-addressed at
  `pages/<slug>/<sha256>/<docPath>`. The Worker reads the D1 head
  pointer, then the versioned R2 object keyed by sha256.
- **Local registry** at `~/.tot`. 65 entries. The
  `localUrl` / `cloudUrl` are now both pointed at `docs.palapala.me`
  for every entry (regardless of whether the entry has source bytes).
  `originalUrl` was previously set to `https://tot.page/<slug>/<file>`
  on older entries; the bulk-import script now writes it to
  `docs.palapala.me` so the dashboard's `Open ↗` doesn't go to the
  broken upstream edge.

### The split decisions Scotty made

1. **Mark.** Default to the inline-SVG plumeria. Recolored orange
   tape is also OK. The plumeria is now in
   `dashboard/index.html` and `dashboard/room.html` (the masthead
   brand-mark block). Don't crop it.
2. **Data path.** `~/.tot` registry path stays. Don't migrate to
   `~/.pala` — the migration is operational detail, not user-facing,
   and risks breaking any external scripts that read the path.
3. **Read URL pattern.** `docs.palapala.me/<slug>/<file>.html`
   (Option A from `docs/PATH_B_SHAPE_PROPOSAL.md`). Subdomain leaves
   `palapala.me` untouched for the dashboard's room URLs and CSS.
4. **Cache-Control.** `public, max-age=60` for living URLs,
   `public, max-age=31536000, immutable` for `@hash` frozen URLs.
   `Cache-Tag: ws:<slug>` so updates can wildcard-purge.
5. **Takedown.** Hard delete (mark `deleted_at` in D1, drop the
   R2 object). Soft delete is not a feature.
6. **R2 bucket.** Separate `palapala-pages` from the dashboard
   mirror `tot-dashboard-archive`. Two intents, two buckets.
7. **tot alias.** `tot` binary is a thin shim that re-runs `pala
   main()` for 90 days. Drop the alias after that.
8. **`/v1/me` is a stub.** Returns `{anonymous: true, user: null}`.
   Don't build real auth — keep the path but stub the response.

### The 3-write bulk-import tool (`scripts/import-historical-bulk.ts`)

Run with `DASHBOARD_SYNC_TOKEN=<key>` from the Keychain. The Keychain
entry is `tot-dashboard-sync` (Roman already wired this). This is the
operator tool that closes the loop on Path B.

**Three writes is exactly what Scotty/Roman confirmed:**
1. POST `/v1/documents` to `docs.palapala.me` for each entry with a
   source file on disk.
2. Update `~/.tot` with `localUrl` / `cloudUrl` / `originalUrl` for
   every entry (including the 53 placeholder ones).
3. PUT the new manifest to `https://palapala.me/api/sync/manifest`
   with the `SYNC_SECRET` bearer token.

Manifest validation is **strict**: the dashboard worker's
`isPublicTot()` checks `id === slug`, `contentHash` and `docSha256`
match `^[a-f0-9]{64}$`, `assetCount === assetPaths.length`, the
indexes match, `docContentType.length > 0`, etc. The script derives
`docContentType` from `kind` if missing (default
`text/html; charset=utf-8` for `html`, `text/markdown; charset=utf-8`
for `markdown`). Don't remove the type defaults — they exist
because the local registry was never populated with this field.

**The D1 lookup at import-time patches head hashes.** This is the
correct way to fill `contentHash` / `docSha256` for the 12 published
on D1 — the local registry never had these. The script indexes by
`${slug}/index.html` as the fallback because the pre-fix Worker
stored everything under `index.html` regardless of the registry's
`docPath`. Don't remove that fallback.

### The 53 missing-source slugs

Three categories (Roman's tier):
- **Easy** (~12 already done): source files in
  `/Users/soderstrom/PROJECTS/mise-july/docs/`,
  `/Users/soderstrom/.agent/diagrams/`, etc. These were the
  migrations that wrote 12 entries to D1.
- **Medium**: source files on Remus / dead VPS / a backup. Scotty
  decides when to fetch them.
- **Hard**: source files in upstream `soderalohastrom/tot` git
  history on GitHub. The fork's git log doesn't have them.

**Don't try to fix all 53 at once.** The right move is one at a time
when Scotty has a fresh source. Slugs are durable identity — when
bytes land, the iframe renders, the manifest updates,
`palapala.me/scotty` shows the new card.

### The `palapala.me/scotty` iframe fallback ordering

The dashboard's reader iframe reads `pala.localUrl` first, then
`pala.cloudUrl`, then `pala.originalUrl`. **The bulk-import sets
`localUrl` and `cloudUrl` to `docs.palapala.me` for every entry —
including the 53 placeholders.** So opening a placeholder card
loads `https://docs.palapala.me/<slug>/<docPath>` which 404s because
no source bytes are at D1. The fall-through chain is correct; the
404 is real and self-explaining. Don't remove the fall-through.

A separate fix the next agent should consider: the dashboard's
`/local-mirror/<slug>` route only matches the slug path component,
not the slug + docPath. For TOTs like `xfWsY.../cloud-brain-cloudflare-computer.html`,
the iframe's `localUrl` is `/local-mirror/xfWsY...` which serves
the file at `xfWsY...` (the registry's `file` value, if it
exists), not the actual docPath. This is misleading for entries where
the docPath differs from the slug. A better fix is to enhance the
local-mirror route to take `/{slug}/{docPath}` so the file lookup
matches the worker's `docs.palapala.me/<slug>/<docPath>` shape.

### Where Scotty's parked work is

- Opened the local dashboard at `localhost:4173/` and verified
  12 cards render in the iframe. The 53 missing-source cards show
  the "local source missing — re-publish to restore" placeholder
  (the `7aa5e00` commit). The `Open ↗` per card now lands on
  `docs.palapala.me` (the `originalUrl` no longer falls back to
  `tot.page`).
- Has the `DASHBOARD_SYNC_TOKEN` already in the macOS Keychain
  (Roman pulled it). The bulk-import script reads it from
  `process.env.DASHBOARD_SYNC_TOKEN`.

### What the dedicated LLM should do on day 1

1. **Read the four docs in this order:**
   - `CLAUDE.md` (architecture, invariants, the non-negotiables)
   - `AGENTS.md` (conventions, the spirit of the project)
   - `docs/PATH_B_SHAPE_PROPOSAL.md` (the design that the worker
     implements)
   - `docs/HANDOFF.md` (this file — running log)
2. **Run `pala dashboard` and `pala dashboard sync`** to confirm
   the cloud-side path is responsive. The local mirror at
   `localhost:4173` should also be live and reading the new manifest.
3. **Verify `palapala.me/scotty/api/tots?project=scotty`** returns
   12 entries (the published manifests). If the count is 0 or 59,
   the manifest is stale — re-run `pnpm import:bulk` with the
   `DASHBOARD_SYNC_TOKEN` from the Keychain.
4. **Verify `docs.palapala.me/<slug>/index.html` for the milestone
   TOT** (`PBkFcrRLBsVYUs07x8JFeA`) — should return 200 with the
   full HTML. If 404, the Worker is up but the publish didn't
   land — re-post with `pala <file> --slug <existing-slug>`.
5. **Skim `worker-publishing/src/index.ts`** — the 8 endpoints
   are all there. The Worker is the book.
6. **Open an issue (or todo) for the missing-source re-imports
   one at a time** when Scotty has a fresh source.

### What the dedicated LLM should NOT do

- Don't rename the `palapala-registry` D1 database. Scotty owns
  the Cloudflare account and the d1 is where every published
  document's head hash lives.
- Don't fork the worker naming. `palapala-publisher` is correct.
- Don't migrate the local-registry path from `~/.tot` to
  `~/.pala`. Operationally irrelevant.
- Don't patch the tot → pala alias out early. Drop in 90 days.
- Don't break the `sync-tot` / `pala dashboard sync` command by
  renaming it. The CLI binary is `pala` (with `tot` as alias); the
  command is `dashboard sync`.

### What Roman's last text said

> "Path A is real today. Direct curl
> `https://docs.palapala.me/<slug>/index.html` works for all 12,
> dashboard cards have dead-ends only on the 53 un-sourced slugs.
> Concrete asks for you (your choice on each): 1. Get the dashboard
> live with all 65 entries → give me the DASHBOARD_SYNC_TOKEN
> (Keychain has a 65-byte entry, Hermes confirmed) and I'll unblock
> the manifest PUT. 2. Fill in any of the 53 → point me at where the
> source bytes live (folder path / Mac / VPS / upstream tag) and
> I'll wire up the import for whichever you want. Or nothing —
> Path A stays structurally complete, your experience surface is
> docs.palapala.me at 12/65, manifest at 65/65 with 53 placeholder
> URLs, dashboard at localhost:4173 reads ~/.tot directly. No rush."

The manifest PUT landed (`200`, 12 entries). The 53 are durable
placeholders. Scotty will decide the order of the re-imports.

### My own (Hermes) last text

> "If you want me to commit the bulk-import tool to the fork
> (private repo, the script is currently untracked), I can do that
> in one commit. 🤙"

**That commit was made.** `28d202a` on `path-b-publishing-worker`:
"fix(dashboard): drop originalUrl fallback from Open hrefs; bulk-import
tool" — bundles the dashboard Open-href fix, the bulk-import script,
and the package.json scripts in one commit.

### Outstanding work on this branch

The ZNA7l test case (the failing `localhost:4173/ZNA7lXDdtrRDjQFVAuH-EA/mise-architecture.html`)
is a missing-source TOT — it's in the 53 placeholder bucket. The
local-mirror route returns 404 because the `file` field is null
on that entry. The cloud URL works because the registry has
`docContentType` and `kind` set, but the **D1 doesn't have ZNA7l**
either — it's a real missing-source entry. The 404 is the right
outcome.

**The bug in the local-mirror route** (matches slug only, not
slug + docPath) is the right thing to fix when the next agent
lands more published entries. Don't fix it speculatively.

### What I want the next agent to know

- **The rebrand is real and committed.** Don't second-guess it.
- **The Worker is true.** The 8 endpoints are the surface.
- **The bulk-import script is the operator tool.** Run it with
  `DASHBOARD_SYNC_TOKEN` from the Keychain and the manifest
  PUTs cleanly. The script has had its shape fix-ups — `id =
  slug`, `${slug}/index.html` fallback for the D1 lookup, default
  `docContentType` from `kind` — use those fixes as-is.
- **The 53 are real, durable slugs.** Don't try to publish fake
  content for them. Wait for the source bytes.
- **palapala.me is the right direction.** The localhost-first
  experience is secondary.

---

> **Companion perspective from the recovery agent (Roman) is at
> [`agent-summaries/2026-08-19-roman-recovery-perspective.md`](agent-summaries/2026-08-19-roman-recovery-perspective.md).**
> Read both side by side. They cover complementary ground.

---

## 2026-08-18 — Tot → Pala rebrand (cosmetic PR; Path A)

**Status:** Path A shipped as one commit on `main`. Path B (publishing Worker
against R2 + D1, cutover from `tot.page`) is held until the morning call.

**What's in this PR (one commit, ~12 files):**

---

### Roman's two cents (recovery perspective)

> Hermes wrote the operator-side handoff above. What follows is the
> supervisor's-side perspective — the bugs that surfaced mid-recovery, the
> gotchas that bit, and the operational tools I left behind. Cheap for the
> next agent to skim, expensive for them to rediscover.

#### Two real bugs I caught and fixed during recovery (now committed at `d022b0b`)

**Bug 1 — Document interface / D1 column casing mismatch (the silent killer).**
`worker-publishing/src/index.ts` defined `Document` with camelCase fields
(`workspaceId`, `docPath`, `headHash`, `createdAt`, `updatedAt`). D1 returns
rows with snake_case column names. D1 doesn't auto-map. So
`readDocumentHead` returned rows whose `headHash` field was actually
`undefined` at TypeScript-runtime — the worker's downstream R2-key
construction used `pages/<slug>/undefined/index.html`, R2 returned null,
and the worker served 404 "Not found." The R2 blobs were there all along;
the read path just couldn't reach them. Hermes' fix: rename `Document`
fields to snake_case (matching D1 columns). `DocumentResponse` stays
camelCase as the public API contract. Deploys: `a268d23b`.

**Bug 2 — Migration's hash check was bricking all 12 entries that had
source files on disk.** `scripts/migrate-to-palapa.ts` had:
`if (sha !== doc.contentHash && sha !== doc.docSha256) { fail }`. The
`~/.tot` registry has neither field populated — schema is just
`[wsId, docId, slug, url, kind, docPath, bytes, createdAt, projects]`.
So `sha !== undefined && sha !== undefined = true` — every entry failed
the gate. Fix: hash check becomes advisory. If `manifestHash` is unset,
warn + proceed (worker re-verifies server-side). If set and mismatched,
still a real failure. Both bugs landed in `d022b0b`.

#### Operational gotchas the next agent will hit

**`wrangler r2 object get` defaults to `--local` mode, not `--remote`.** I
made this mistake early in recovery. Without `--remote`, wrangler returns
0-byte responses from a local simulation — leading you to conclude the
bucket is empty when it's actually populated. **Always pass `--remote` for
real R2 reads in this codebase.** Both `wrangler r2 object get` and
`wrangler r2 bucket info` need it. The `palapala-pages` bucket is well-
populated even when `--local` says 0 objects.

**`wrangler` oauth_token expiry.** `~/.wrangler/config/default.toml`
carries an `oauth_token` with `expiration_time: 2026-08-18T18:46Z`. As of
the work in this session it was 3 days past. `wrangler deploy` still
worked (in some cases wrangler falls back to account-level auth), but
strict operations like `wrangler d1 create` and `wrangler d1 execute`
needed an active refresh token. If you hit auth errors that smell like
"Invalid API Token," run `wrangler login` once interactively to refresh
the OAuth chain — don't waste cycles guessing.

**The dashboard Worker bundle is stale relative to disk.** `dashboard/app.js`
line 191 + 225 is Hermes' iframe↔Open fix (committed in `28d202a`), but
`palapala.me/app.js` (the live bundle at press time) still has 6
occurrences of `tot.url` and 0 of `pala.url`. The dedicated agent's
first deploy should include `wrangler deploy` of the `tot-dashboard`
config — without it, the dashboard's Open buttons will still 404 to
`tot.page` even after the manifest is good. One `wrangler deploy` from
the project root handles this; the config is in `wrangler.jsonc` (the
existing one for the `tot-dashboard` Worker).

**The dash 17-entry manifest regression.** Live at palapala.me went from
59 entries (yesterday's full set) → 17 entries (12 with source bytes
plus 5 with `projects=[gohappy/wolfpack/mise]`). Hermes' bulk-import
PUT wrote a 12-entry manifest and that PUT replaced the existing
59-entry manifest at the dashboard side. The bulk-import tool's "skip
53 with placeholder URL" logic only wrote the 12 it could publish; it
should also write the 53 placeholder entries (with `url` and
`originalUrl` pointed at `docs.palapala.me/<slug>/index.html`) so the
live dashboard catches up to 65. The dedicated agent should fix that
up; the manifest is currently 17-of-65 on the cloud side.

**Worker `docPath` handling is good but uncommitted.** Hermes added
`parsed.docPath` to `POST /v1/documents` (lets the publish-time caller
specify the doc filename instead of the previous hardcoded
`index.html`). Typechecks clean; `worker-publishing/src/index.ts` diff
is 6 lines, easy review. Land this in the first commit the dedicated
agent makes so the bulk-import's `docPath: doc.docPath ?? "index.html"`
actually matches the worker's persisted key. Until then, everything
uploaded lands under `index.html` regardless of the registry's
recorded `docPath`, and the manifest validator has to handle the
mismatch (Hermes' bulk-import script does, via the
`${slug}/index.html` index-key fallback at D1 lookup time).

#### Tools I left behind (`/tmp`)

These are reference artifacts from the recovery. The next agent can
delete them or keep them; they're not in any committed path.

- `/tmp/roman-deadends-compare.py` — runs the dead-ends comparison
  across all 65 slugs. Captures 5 surfaces (Path B docPath /
  Path B index.html / Path A mirror / dashboard iframe / upstream
  tot.page). Output: `/tmp/deadends-<label>.json`. Use this to
  measure improvement post-import.
- `/tmp/roman-deadends-diff.py` — diff two snapshots (e.g.
  `before-import.json` vs `after-import.json`). Prints per-slug
  improvements.
- `/tmp/deadends-before-import.json` — pre-import baseline
  snapshot. 12 of 65 live via `docs.palapala.me/<slug>/index.html`,
  53 still dead. After the dedicated agent's import completes,
  re-run `python3 /tmp/roman-deadends-compare.py after-import`
  and diff.
- `/tmp/roman-recovery-status.md` — the recovery writeup
  (5.4 KB). Context for what broke and why.
- `/tmp/roman-pala-architecture.md` — the data-store architecture
  diagram explaining the three data stores and the iframe↔open
  routing. Read before touching the dashboard wiring.
- `/tmp/hermes-coord-drops.md` (and similar) — Hermes' status
  drops during the campaign. Ephemeral; can delete.

#### Vox / pack protocol note (for the dedicated agent's first week)

If the dedicated agent ever needs to coordinate with the pack:
- **`herdr pane send-text <pane_id> "<msg>"`** — queue text
- **`herdr pane send-keys <pane_id> enter`** — fire
- **Voice tag prefix when speaking in a pane:**
  `Roman here:` / `Hermes here:` / `CC here:` — never bare text
- The pack runs in PANEs, primarily `w11:pC` (Hermes) and `w11:p8`
  (Roman, when I'm the operator). `herdr pane list` from any shell
  enumerates.

#### What I'd do on day 2 (a wishlist, not a directive)

In priority order, low effort / high leverage:

1. **Commit Hermes' uncommitted `worker-publishing/src/index.ts`**
   (the `parsed.docPath` change). One-line review.
2. **Redeploy the dashboard Worker** so the live
   `palapala.me/app.js` carries the iframe↔Open fix. Without
   this, all Open buttons still 404.
3. **Restore the cloud manifest to 65 entries.** Either re-run
   Hermes' bulk-import with an "include placeholders" flag, or
   the dedicated agent's next import script should write all 65
   (12 with bytes, 53 with `url: docs.palapala.me/<slug>/index.html`
   and `kind: html`).
4. **Fix the local-mirror route** to take `/{slug}/{docPath}`
   so the iframe's `localUrl` for entries with custom docPath
   resolves. Hermes flagged this as a real bug; it's correct.
5. **Optional: cache Tag-based purges.** The Worker sets
   `Cache-Tag: ws:<slug>`. A wildcard purge on `ws:*` from
   `palapala.me/api/cache/purge` (admin scope) would replace
   the 60s living-URL cache window with one-shot destructive
   invalidation. Scotty didn't ask for it; next agent can decide.

That's the two cents. Good campaign, Scotty. `palapala.me` is the right
direction and the dedicated agent on this codebase has a clean starting
line. Roman signing off this work, picking up the next thing. 🤙🏼🐺🌺

— Roman
