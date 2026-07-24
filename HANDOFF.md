# Handoff

Notes for whichever LLM picks this repo up next. Running log, newest first.
For durable architecture and invariants see [`CLAUDE.md`](CLAUDE.md); for direction
see [`ROADMAP.md`](ROADMAP.md).

---

## 2026-07-23 — Phase 1 deployed + Phase 2 in-dashboard tagging UI

Since the Phase 1 entry below (which said "not yet deployed"):

- **Phase 1 deployed** to palapala.me. One deploy-only bug fixed: the
  `/<project>` shell route fetched `/index.html`, which Cloudflare Assets
  canonicalizes to a 307 → `/`, bouncing browsers out of the scoped view. Now
  fetches the root (`worker/index.ts`); the worker test stubs the same
  canonicalization so it can't regress. Commits `8f03b82`, `421706c` (pushed).
- **Rooms populated:** 24 Tots tagged `mise`, 3 tagged `gohappy`, verified live
  at palapala.me/mise and palapala.me/gohappy.

**Phase 2 — tagging UI in the local dashboard (this entry):**

- `DashboardTot` now carries `projects`, exposed by `dashboardTots()`
  (`src/dashboard.ts`). The loopback PATCH endpoint already accepted a
  `projects` patch (Phase 1), so no server-auth change.
- `dashboard/app.js` + `index.html` + `app.css`: a tag button in the card
  action cluster opens a `<dialog>` with the current rooms as removable chips
  and an input (with a `<datalist>` of existing slugs). Add/remove **persist
  immediately** via the existing `mutateTot` path — no separate save. Cards show
  their room chips inline; fuzzy search now matches project slugs too.
- **Privacy:** card chips and the tag button are gated on `state.canManage`, so
  a client viewing `/mise` never sees a Tot's other room memberships. (Note: the
  scoped `/api/tots?project=` response still includes each Tot's full `projects`
  array — a network-inspector could see other slugs. Acceptable under the
  curation-not-security posture; strip it in `serveScopedManifest` if that ever
  matters.)
- Verified live in the browser: add → chip appears in dialog + on card; remove →
  gone; no leftover test tags. `pnpm typecheck` + 98/98 tests + oxlint clean.

**NOT done:** Phase 2's other two items — per-project branding (`projectMeta`
name/blurb/accent) and owner-root-behind-Access — not started.

---

## 2026-07-21 — client reading rooms: Phase 1 MVP implemented (not yet deployed)

Built the full Phase 1 work list from `docs/CLIENT_VIEWS_SPEC.md` (Kimi session,
picking up from a CC session that settled the open questions):

- **Decisions recorded** in the spec §2 and ROADMAP: privacy bar = curation
  (capability URLs are enough, root stays public, hedge = thin landing +
  private-slug master list if two clients must ever not see each other);
  URL shape = bare `/<project>` with the RESERVED guard.
- `src/projects.ts` — slug pattern + `isProjectSlug` / `normalizeProjectSlug` /
  `normalizeProjects`. The Worker mirrors the regex as a constant (keep in sync).
- `RegistryEntry.projects` + `DashboardEntryPatch.projects`; normalization
  happens in `Config.updateDashboardEntry` (null clears, array replaces).
- CLI: `tot dashboard tag|untag <slug|url> <project>` and
  `tot dashboard tags [<slug|url>]` — local-only, no network.
- Manifest: `PublicTot.projects`, populated (normalized) by the sync builder;
  `isPublicTot` accepts a missing field for pre-projects manifests.
- Worker: `GET /api/tots?project=<slug>` filters server-side and returns
  `capabilities.manage: false`; bad slug → 400; unknown slug → empty list.
  `GET /<project>` serves the dashboard shell (`index.html`) for any
  single-segment non-RESERVED path; unknown slugs render the SPA empty state.
- `dashboard/app.js`: reads the project slug from `location.pathname`, fetches
  the scoped manifest, forces `canManage=false`, and swaps the masthead to the
  humanized slug. The local loopback dashboard is unaffected (serves only `/`).

**Verified:** `pnpm format/lint/typecheck` clean; 97/97 tests (new:
projects helper, config patch normalization, loopback patch validation, sync
projection with projects, worker scoped filter + shell route + reserved
fallthrough, CLI tag round-trip). Live smoke on the real registry:
tag → `tot dashboard sync` (old worker accepted the new manifest shape;
`projects` visible in `palapala.me/api/tots`) → untag → re-sync. Cloud and
local state restored to zero tags afterwards.

**NOT done:** `pnpm cloud:deploy` — the scoped filter and `/<project>` route
only exist locally until the Worker is deployed. Phase 2 (tagging UI in the
local dashboard, `projectMeta` branding, owner root behind Access) not started.

---

## 2026-07-20 — cloud dashboard: two production fixes + docs/roadmap snapshot

The cloud dashboard (Worker + R2, now live at **palapala.me**) had two bugs that
made it look healthy while silently failing. Both fixed and deployed.

1. **R2 rejected every new upload (500).** `storeObject` in `worker/index.ts`
   piped the request body through a `TransformStream` (to count bytes + hash),
   which drops the stream's known length; `R2Bucket.put` refuses unknown-length
   streams — "Provided readable stream must have a known length". So every _new_
   object 500'd while dedup re-uploads (204) masked it. The 5-minute LaunchAgent
   sync had failed ~1,300× over six days. **Fix:** rejoin the already-validated
   content-length via `new FixedLengthStream(length)` before the R2 put.
   `FixedLengthStream` is a workerd-only global, so `test/setup.ts` stubs a
   pass-through for the vitest node env.

2. **Card/reader previews were broken images.** The manifest `url` field was an
   absolute `https://tot-dashboard.scott-c93.workers.dev/mirror/…` URL. On the
   palapala.me custom domain that origin is cross-origin, and the dashboard CSP
   is `frame-src 'self' https://tot.page` → every preview iframe blocked. **Fix:**
   make the manifest `url` a **same-origin relative** `/mirror/…` path (in both
   the sync builder and the restore builder, `src/cloud-sync.ts`). `originalUrl`
   stays absolute (the tot.page "Open ↗" link).

3. **Access made opt-in.** `worker/index.ts` no longer fails closed with `503`
   when Access env vars are unset. Access verification runs only when _both_
   `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set (`wrangler.jsonc`); they're
   currently empty, so palapala.me is publicly readable. `/api/sync/*` is still
   always `SYNC_SECRET`-gated. (This was an in-progress local change from a prior
   session; reconciled and shipped.)

**Docs written this session** (the "snapshot for the future" the owner asked for):
`CLAUDE.md` (new, repo-level architecture + invariants), `ROADMAP.md` (new,
direction), `docs/CLIENT_VIEWS_SPEC.md` (new, the next feature's build plan),
plus accuracy updates to `README.md` and `docs/CLOUD_DASHBOARD.md`.

**Next feature (speced, not started):** per-client reading rooms at `/<project>`
via a `projects[]` tag on registry entries and a server-side `?project=` manifest
filter. Full plan in `docs/CLIENT_VIEWS_SPEC.md`.

**Verified:** `pnpm typecheck` + `pnpm test` (83/83) green; deployed via
`pnpm cloud:deploy`; forced `tot dashboard sync` cleared the backlog (39 tots);
`launchctl kickstart` of the sync job now exits 0; `palapala.me/api/tots` serves
relative `/mirror/…` paths that resolve 200 same-origin.

**Uncommitted:** all of the above is in the working tree, not yet committed.

---

## 2026-07-01 — Open Graph / Twitter Card support

**Goal:** pages published with `tot` were invisible to Slack/Notion/Discord/iMessage
link-unfurlers — no `<title>`, no OG tags, so shared links rendered as bare text.

1. **`src/og.ts`** — `injectOpenGraph(html, meta)`. Injects `<title>` + description +
   Open Graph + Twitter Card `<meta>` tags right after `<head>` (not before `</head>`,
   so they win over any pre-existing tags in the source file — crawlers use the first
   match). Escapes all values.

2. **`src/banner.ts`** — `renderBannerPng(meta)`. When `--title` is passed without
   `--image`, the CLI auto-generates a colored 1200×630 title/description card and
   publishes it as the `og:image`/`twitter:image`, so every page gets a real thumbnail
   with zero extra steps. Rendered via `@resvg/resvg-js` (Rust/napi-rs, prebuilt
   binaries) rather than shelling out to `rsvg-convert`/ImageMagick, since this is a
   published npm package — it can't assume a system binary exists on someone else's
   machine. Color is chosen deterministically by hashing the title across 6 warm
   palettes (teal/amber/forest/brick/indigo/plum), so re-publishing the same page
   keeps the same color. Text is real word-wrapped (2 lines max, conservative
   char-width budget) — an earlier char-count-truncation approach let long
   descriptions run off the canvas edge; fixed and covered by a regression test.

3. **`src/commands.ts`** — `publishCommand`/`updateCommand` wire the above in.
   New `PublishOpts.og` (title/description/image/url) and `PublishOpts.noAutoImage`.
   Key wrinkle: a **fresh** `tot <file>` publish doesn't have a slug yet, but
   `og:image` needs an absolute URL baked into the HTML _before_ upload — so when
   auto-image applies, the workspace is created early (extra `POST /v1/workspaces`)
   just to learn the slug, then reused for the asset+document upload instead of
   creating it twice. `tot update` has no such problem — the slug is already known
   from the registry, so auto-image resolves inline. The auto-generated asset is
   named `__tot-og-image.png` (double-underscore namespaced) to avoid colliding with
   a real content image of the same name.

4. **`src/cli.ts`** — new flags: `--title`, `--description`, `--image`, `--url`,
   `--no-image`. `--title` is required to use any of the others. Markdown files
   error clearly if OG flags are passed (`.md` has no `<head>`).

5. **Global install swapped** — the `tot` binary on this machine's PATH
   (`/opt/homebrew/bin/tot`) was the published `@plannotator/tot` npm package;
   it's now `npm link`'d to this working copy, so `pnpm build` here immediately
   affects the live `tot` command. No re-link needed after future edits — just rebuild.

6. **Toolchain pins fixed** (unrelated to the OG feature, but was blocking a clean
   `pnpm build`): this repo's `packageManager` bumped `pnpm@10.18.0` → `pnpm@11.9.0`.
   The `pnpm` binary that was actually resolving on this machine's PATH was a stale
   `pnpm@9.0.4` installed as a plain dependency in `~/package.json` (not a corepack
   shim) — it was swapped in place to `11.9.0` too. `pnpm-workspace.yaml` in this repo
   is new: pnpm 11 blocks postinstall scripts by default now, and `esbuild` (a
   `vitest` transitive dep) needed one approved (`pnpm approve-builds --all`
   wrote this file).

7. **Companion skill updated** — `~/.claude/skills/tot-publish/SKILL.md` (v1.1.1 →
   v1.2.0), _not_ part of this repo. Documents the new flags, corrects an outdated
   claim that `tot` "cannot fetch assets" / has no image support (it does — local
   images/CSS/JS upload automatically, which is exactly what the auto-banner uses),
   fixes an inaccurate `tot update <file> <url>` two-arg example (the CLI only ever
   reads one positional), and adds a "vary the accent color, at will" note so
   agent-generated pages don't all default to the same teal-on-paper look.

## Verified against the live API

Published and inspected several real test pages during this session (dogs, cats,
birds) at `tot.page/...` — confirmed `og:image`/`twitter:image` resolve to live
200-OK PNGs, `<head>` tags are correct, and the word-wrap fix actually renders
without clipping. No stub-only testing — this went through the real
`workspaces.plannotator.ai` API.

## Test coverage added

`test/og.test.ts`, `test/banner.test.ts`, integration cases in
`test/commands.test.ts` (auto-image on publish/update, explicit `--image` skips
generation, `--no-image` suppresses it, unchanged title/description skips
re-uploading the deterministic banner). 58/58 tests passing as of this commit.
`pnpm typecheck` shows one **pre-existing, unrelated** error in `src/http.ts`
(a `@types/node`/`fetch` overload mismatch) — confirmed via `git stash` that it
predates this session; not touched.

## Known simplifications / follow-ups (not blockers)

- Banner text wrapping uses a conservative estimated average character width,
  not real glyph metrics — safe (errs toward wrapping early) but not pixel-perfect.
- No markdown→HTML conversion mode — `--title`/etc. only work on `.html` files.
  Raw `.md` publishing is unaffected and still works as before.
- `og:url` on a **fresh** publish is only set if you pass `--url` manually (the
  slug doesn't exist yet at HTML-generation time). On `tot update` it auto-fills
  from the page's already-known living URL.
- The auto-banner asset path (`__tot-og-image.png`) is a fixed name, not
  content-addressed — fine in practice (one banner per page), just noting it's
  a convention rather than a guarantee against a determined name collision.

## To resume verifying

```bash
cd /Users/soderstrom/PROJECTS/tot
pnpm install && pnpm build && pnpm test   # 58/58, no COREPACK_ENABLE_STRICT needed
tot /tmp/whatever.html --title "Test" --description "..."   # auto-banner, live publish
```
