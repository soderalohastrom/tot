# CLAUDE.md — pala

Context and direction for any LLM working in this repo. Read this first, then
`docs/` for depth. Keep it current: if you change an invariant below, update this file.

## What this is

`pala` — a CLI that publishes a Markdown/HTML file to a living
`docs.palapala.me/<slug>` URL (git-backed: `pala update` moves the same link
forward, every publish also keeps a frozen `@hash` snapshot). Forked from
`@plannotator/tot`; **the publishing backend is now self-hosted** — the
`palapala-publisher` Worker (R2 + D1) replaced the upstream
`workspaces.plannotator.ai` API, which is dead. The repo also runs the **cloud
dashboard**: a second Cloudflare Worker + private R2 bucket that mirrors
published pages into a searchable, self-hostable reading room at
**palapala.me**.

## Two planes

1. **CLI plane** (`src/`, ships as the `pala` binary; `tot` is a 90-day alias).
   Publishes pages, holds the local registry `~/.tot`, and runs
   `pala dashboard` (local server) and `pala dashboard sync` (pushes a
   sanitized mirror to the dashboard Worker).
2. **Edge plane** — two Workers:
   - `palapala-publisher` (`worker-publishing/src/index.ts` +
     `wrangler-publishing.jsonc`): the `/v1` API + raw content on
     `docs.palapala.me`. D1 `palapala-registry` maps slug → head hash; R2
     `palapala-pages` holds content-addressed bytes
     (`pages/<slug>/<sha256>/<docPath>`, assets at `assets/<slug>/<path>`).
   - `tot-dashboard` (`worker/index.ts` + `dashboard/` + R2
     `tot-dashboard-archive`): the reading-room mirror at palapala.me.

The CLI ↔ dashboard contract: the CLI PUTs objects and a manifest to
`/api/sync/*`; browsers GET `/api/tots` (manifest) and `/mirror/*` (page content).
The CLI ↔ publisher contract is the upstream `/v1` shape (snake_case entities,
raw-body PUT, 204 DELETE) — keep `worker-publishing` byte-faithful to what
`src/http.ts` expects; the CLI's stubbed tests assert it.

## Key files

| File | Role |
|---|---|
| `src/cli.ts` | Command dispatch (`publish`, `update`, `list`, `dashboard …`). |
| `src/cloud-sync.ts` | Sync/backup/restore. Builds the sanitized manifest; talks to the Worker. |
| `src/config.ts` | `~/.tot` shape — `RegistryEntry`, `DashboardEntryPatch`. The source of truth for what's published. |
| `src/dashboard.ts` | Local (loopback) dashboard server + management API. |
| `worker/index.ts` | The edge Worker: sync auth, manifest, `/mirror/*`, optional Access gate, static-asset fallthrough. |
| `dashboard/app.js` | The dashboard SPA (cards/list, search, reader iframe). Same code local and cloud. |
| `docs/` | `CLOUD_DASHBOARD.md` (architecture), `SPEC.md` (product spec), `CLIENT_VIEWS_SPEC.md` (next feature), `REPO_LAYOUT.md`. |
| `ROADMAP.md` | Where this is going — read it before proposing large changes. |

## Invariants (do not break without saying so)

- **Sanitized manifest.** The public manifest (`/api/tots`) carries display
  names, original URLs, mirror paths, hashes, sizes, timestamps, asset paths —
  and *never* API keys, workspace/document IDs, or local filesystem paths. Keep
  it that way when you add fields.
- **Content-addressed & immutable.** Mirror objects live at
  `tots/<slug>/<contentHash>/<docPath>`. Uploads dedupe by SHA-256; an object
  key never changes content. Sync uploads objects *before* the manifest.
- **Same-origin mirror URLs.** The manifest `url` field is a **relative**
  `/mirror/…` path, not an absolute origin. The dashboard iframes it under
  whatever host serves it, and the page CSP is `frame-src 'self' https://docs.palapala.me`.
  An absolute cross-origin URL gets blocked. (`originalUrl` stays absolute —
  it's the external "Open ↗" link.)
- **`~/.tot` is the only record of anonymous pages.** There is no server-side
  listing. `Config.load/save` guards it (atomic write, corrupt-file preserve).
  Never let a code path silently truncate it.
- **Management is capability-gated.** `/api/tots` returns `capabilities.manage`.
  It's `true` only for the loopback local dashboard (with an ephemeral token);
  the cloud mirror is read-only. Rename/hide/tag are local-metadata mutations.
- **No unscoped catalog on the edge.** `/api/tots` with no `?project=` is a 404
  in the Worker. Every cloud read is scoped to a room, including the owner's.
  Restoring an unscoped listing re-exposes the whole mirror to `curl`.
- **Assets serve literal paths.** `html_handling` is `"none"`, and the Worker
  names the file for each route (`/` → `index.html`, `/<project>` →
  `room.html`). The default mode 307s `/index.html` → `/` and `/room.html` →
  `/room`; both have already caused shell-routing bugs. Don't rely on
  canonicalization, and don't add a route that fetches a bare path.

## Access model (current state)

Two layers, both currently in effect:

1. **Room scoping.** The public root serves `dashboard/index.html` — a dead-end
   landing page with no catalog and no links into the rooms. Content is only
   reachable through `/<project>` (`/mise`, `/gohappy`), which the Worker
   filters server-side. The owner's full catalog is `OWNER_SLUG`, a **secret**
   holding an unguessable project slug that `serveScopedManifest` matches
   against every Tot instead of filtering. Unset = no owner room exists; an
   empty slug never matches. Rotate with `wrangler secret put OWNER_SLUG`.
   This is curation, not secrecy: Tots stay public-by-link on tot.page, and
   `/mirror/*` paths remain reachable if you already know slug + hash.
2. **Cloudflare Access** verification in the Worker is **opt-in**, gated on both
   `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` being set in `wrangler.jsonc`. They are
   currently **empty**. Setting both requires an Access JWT for *all* browser
   routes, which would put a login in front of the client rooms too — that is
   why the rooms are gated by slug scoping instead.

The `/api/sync/*` routes are always protected by the `SYNC_SECRET` bearer token
(+ an Access service token when Access is on). See `docs/CLOUD_DASHBOARD.md`.

## Build · test · deploy · sync

```bash
pnpm build          # tsc → dist/. The global `pala` is npm-linked here, so this updates it live.
pnpm typecheck      # wrangler types check + tsc --noEmit (covers worker/ AND worker-publishing/)
pnpm test           # vitest, plain-node env (no workerd; worker globals are stubbed in test/setup.ts)
pnpm cloud:types    # regenerate worker-configuration.d.ts after editing wrangler.jsonc vars
pnpm cloud:deploy   # wrangler deploy (the tot-dashboard Worker; publisher uses --config wrangler-publishing.jsonc)
pala dashboard sync # regenerate + push the mirror manifest (also runs every 5 min via LaunchAgent)
```

**Gotcha:** `worker/index.ts` reads `env.*` vars declared in `wrangler.jsonc`.
After changing `vars`, run `pnpm cloud:types` or `pnpm typecheck` fails with
"Property … does not exist on type 'Env'". Worker-only globals like
`FixedLengthStream` don't exist under vitest's node env — `test/setup.ts` stubs them.

## Discipline

Follow the Karpathy guidelines (`karpathy-guidelines` skill for non-trivial work):
think before coding, simplicity first, surgical changes, goal-driven execution.
Match existing style. Verify with the commands above — this project mirrors real
content, so a broken sync or a leaked manifest field has real consequences.
