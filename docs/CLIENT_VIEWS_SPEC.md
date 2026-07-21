# Client Reading Rooms — Build Spec

Status: **proposed** (not yet implemented). Author target: any LLM or human
picking up the feature described in [`../ROADMAP.md`](../ROADMAP.md).

This is a feature spec layered on top of the shipped cloud dashboard. It does not
restate the whole system — see [`CLOUD_DASHBOARD.md`](CLOUD_DASHBOARD.md) for
architecture and [`SPEC.md`](SPEC.md) for the product spec. Read the repo
[`CLAUDE.md`](../CLAUDE.md) invariants first; this spec is written to respect them.

## 1. Goal

Serve `https://<host>/<project>` (e.g. `palapala.me/canlis`) as a read-only
reading room showing only the Tots tagged for that project, so the owner can hand
a client a single link scoped to exactly the pages that concern them — without
exposing the rest of the catalog and without any per-client rebuild.

## 2. Locked decisions

- A **project** is a lowercase slug (`[a-z0-9][a-z0-9-]{0,63}`). A "client view"
  is a project. No separate entity — a project exists iff at least one Tot is
  tagged with it (until Phase 2 adds a branding map).
- A Tot may belong to **many** projects → `projects: string[]` on the entry, not
  a single field.
- Filtering is **server-side**. A scoped view must never receive Tots outside its
  project. The browser filtering the full manifest client-side is disallowed —
  it would leak the catalog.
- Project tags are **local dashboard metadata**, exactly like `displayTitle` and
  `hidden`: they never rename the source file, never touch the published tot.page
  document, and are applied only through the loopback management API or the CLI.
- The reading room is **read-only**: `capabilities.manage` is always `false`
  there, regardless of how the owner is authenticated.
- **Privacy posture (decided 2026-07-21):** curation, not security. The
  underlying Tots are already public-by-link on tot.page, so a project slug is
  a capability URL — fine as the only bar. The unscoped root `/` also stays
  public. If the aggregate catalog at `/` ever becomes sensitive (e.g. two
  clients who must not see each other), the hedge is: serve a thin landing at
  `/` and move the full master list to a private slug only the owner knows —
  no hand-rolled password form. Cloudflare Access scoped to the owner's email
  (§5.3) remains the heavier option.
- Reuse the **existing dashboard SPA** (`dashboard/app.js`) unchanged in
  structure — the scoped view is the same app with a project context and
  management chrome suppressed.

## 3. Data model

### 3.1 Registry (`src/config.ts`)

Add to `RegistryEntry`:

```ts
/** Project slugs this Tot appears under in scoped client reading rooms.
 *  Dashboard metadata only — does not affect the published document. */
projects?: string[];
```

Add to `DashboardEntryPatch` (the loopback mutation payload):

```ts
projects?: string[] | null;   // null clears; array replaces the set
```

Normalize on write: lowercase, dedupe, drop empties, validate against the slug
pattern, sort. Reject unknown patch shapes as today.

### 3.2 Public manifest (`src/cloud-sync.ts` → `PublicTot`)

Add `projects: string[]` to the `PublicTot` shape and to `isPublicTot` validation
(`Array.isArray(tot.projects) && tot.projects.every(isProjectSlug)`; treat a
missing field as `[]` for backward compatibility with already-synced manifests).
Populate it in the sync builder next to `hidden`/`displayTitle`.

**Privacy check:** `projects` is a set of slugs the owner chose — safe to expose.
It carries no key, ID, or path. Manifest invariant preserved.

### 3.3 Project slug helper

One shared validator/normalizer used by the CLI, the patch handler, and the
Worker: `isProjectSlug(s)` + `normalizeProjectSlug(s)`. Put it where both planes
can import it (a small `src/projects.ts`), and mirror the regex as a constant in
the Worker (the Worker does not import from `src/`).

## 4. Tagging surface

### 4.1 CLI (Phase 1)

```
tot dashboard tag   <slug|url> <project>     # add a project to a Tot
tot dashboard untag <slug|url> <project>     # remove it
tot dashboard tags  [<slug|url>]             # list tags (all Tots, or one)
```

Resolve `<slug|url>` against the registry as existing commands do, mutate
`entry.projects`, `Config.save()`. These are local-only; no network.

### 4.2 Local dashboard UI (Phase 2)

Add a tag control to the card management cluster (next to rename/hide), gated on
`state.canManage`, POSTing a `projects` patch through the existing loopback
management endpoint + ephemeral token (`src/dashboard.ts`). No new auth surface.

## 5. Serving a scoped view (Worker — `worker/index.ts`)

### 5.1 Scoped manifest

Extend the `/api/tots` handler:

```
GET /api/tots?project=<slug>
```

- Validate `<slug>` against the project-slug regex; 400 on bad input.
- Load the stored manifest, filter `tots` to entries whose `projects` includes
  the slug **and** that are not `hidden`.
- Return `{ tots: filtered, capabilities: { manage: false } }`.
- Unscoped `GET /api/tots` (no param) is unchanged — the owner's full view.

The filter is O(n) over the catalog; no index needed at this scale
(`// ponytail: linear scan, add an index if the catalog reaches thousands`).

### 5.2 The `/<project>` route

Insert **before** the static-asset fallthrough at the end of `handleRequest`:

```
if GET/HEAD and pathname is a single segment /<seg>:
    if <seg> is a RESERVED name → fall through (normal asset handling)
    else → serve the dashboard shell (index.html) with dashboard security headers
```

`RESERVED` is the closed set of real top-level routes and asset basenames:
`health`, `api`, `mirror`, `favicon.ico`, `app.js`, `app.css`, `reader-layout.js`,
`index.html`, and anything else physically in `dashboard/`. Everything else is
treated as a candidate project slug. Serving `index.html` (not a 404) lets the
SPA boot; it then calls the scoped manifest and renders empty-state if the
project has no Tots (an unknown slug simply shows "nothing here").

Reserved-name collision is why the bare form needs the guard. If a future top-level
asset is added, add its basename to `RESERVED`. The zero-collision alternative is
`/p/<project>` (no guard, but a less clean URL) — decide in ROADMAP Phase 1.

Note `wrangler.jsonc` sets `run_worker_first: true`, so the Worker owns routing
and `env.ASSETS.fetch` is only reached where we call it — the interception above
is authoritative.

### 5.3 Access interaction

The optional Access gate wraps browser routes today. For scoped views two owner
choices exist (ROADMAP Phase 2/3):

- **Public rooms:** leave Access off (current state). `/<project>` and its scoped
  manifest are readable by anyone with the link (capability URL).
- **Private root, public rooms:** protect `/` and unscoped `/api/tots` with
  Access, but exempt `/<project>` + `/api/tots?project=` from the gate so clients
  read without a login. Implement by checking the project route/param *before*
  the Access gate. Only safe when capability URLs are an acceptable bar.
- **Private rooms (Phase 3):** a per-project self-hosted Access application scoped
  to `/<project>` with an Allow policy for the client's email. No app-code auth;
  the Worker keeps returning `manage:false`.

## 6. Client UI (`dashboard/app.js`)

- On boot, read the project slug from `location.pathname` (first segment, minus
  reserved). Store `state.project`.
- If `state.project`, fetch `/api/tots?project=<slug>` instead of `/api/tots`;
  force `canManage=false`; render a project heading (slug-derived in Phase 1,
  from branding metadata in Phase 2).
- Everything else — cards/list, fuzzy search, reader iframe — is unchanged. Mirror
  URLs are already same-origin relative paths, so the reader and previews work
  under `/<project>` with no change.
- Keep the existing `no-store` fetch so a newly tagged Tot appears on reload.

## 7. Branding (Phase 2)

Add an optional `projects` metadata map to `~/.tot`:

```jsonc
"projectMeta": {
  "canlis": { "name": "Canlis", "blurb": "Server onboarding docs", "accent": "#8a5a2b" }
}
```

Sync a sanitized copy into the manifest (name/blurb/accent only). The scoped view
renders it in the header. Absent metadata → fall back to the humanized slug.

## 8. Work items

**Phase 1 (MVP)**
1. `src/projects.ts` — slug regex + normalize/validate helper. Unit test.
2. `RegistryEntry.projects` + `DashboardEntryPatch.projects` + patch handler
   normalization (`src/config.ts`, `src/dashboard.ts`). Test the patch path.
3. `tot dashboard tag/untag/tags` (`src/cli.ts`). Test resolution + mutation.
4. `PublicTot.projects` + `isPublicTot` + sync builder (`src/cloud-sync.ts`).
   Update the sanitized-projection test.
5. Worker: `?project=` filter on `/api/tots`; `/<project>` shell route + RESERVED
   guard (`worker/index.ts`). Extend `test/worker.test.ts` (scoped filter returns
   only tagged + non-hidden; reserved names still serve assets; bad slug → 400).
6. `app.js`: project context, scoped fetch, forced read-only, heading.
7. Rebuild, `tot dashboard sync`, deploy, verify (§9).

**Phase 2** — local tagging UI; `projectMeta` + branding; owner root behind Access.
**Phase 3** — per-project Access policies; who-can-see-what audit.

## 9. Verification

```bash
pnpm typecheck && pnpm test        # all green, incl. new project tests
pnpm build && tot dashboard tag <slug> canlis && tot dashboard sync
pnpm cloud:deploy
```

Then, against the live host:
- `GET /api/tots?project=canlis` returns only Tots tagged `canlis`, none `hidden`,
  and `capabilities.manage === false`.
- `GET /api/tots?project=<unknown>` returns `{ tots: [] }` (200), not 500.
- `GET /canlis` returns the dashboard HTML (200) and the page renders the tagged
  Tots with working previews; an unknown slug renders the empty state.
- `GET /api/tots` (unscoped) is unchanged — full catalog.
- Reserved names still resolve: `/app.js`, `/health`, `/api/tots`, `/mirror/…`.
- Confirm the scoped manifest response contains **no** entry for an untagged Tot
  (server-side filter, not client-side hiding — inspect the raw JSON).

## 10. Non-goals (for now)

- No per-Tot ACLs beyond project membership.
- No editing/uploading from a client room.
- No cross-host project federation.
- No expiry/revocation of links (parked in ROADMAP "Later").
