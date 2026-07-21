# CLAUDE.md — tot

Context and direction for any LLM working in this repo. Read this first, then
`docs/` for depth. Keep it current: if you change an invariant below, update this file.

## What this is

`@plannotator/tot` — a CLI that publishes a Markdown/HTML file to a living
`tot.page/<slug>` URL (git-backed: `tot update` moves the same link forward,
every publish also keeps a frozen `@hash` snapshot). This fork adds a **cloud
dashboard**: a Cloudflare Worker + private R2 bucket that mirrors your published
pages into a searchable, self-hostable reading room, served from your own domain
(currently **palapala.me**).

## Two planes

1. **CLI plane** (`src/`, ships as the `tot` binary). Publishes pages, holds the
   local registry `~/.tot`, and runs `tot dashboard` (local server) and
   `tot dashboard sync` (pushes a sanitized mirror to the Worker).
2. **Edge plane** (`worker/index.ts` + `dashboard/` static assets + R2). Serves
   the same dashboard UI from a content-addressed mirror. Deployed with Wrangler.

The two talk over a small HTTP contract: the CLI PUTs objects and a manifest to
`/api/sync/*`; browsers GET `/api/tots` (manifest) and `/mirror/*` (page content).

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
  whatever host serves it, and the page CSP is `frame-src 'self'`. An absolute
  cross-origin URL gets blocked. (`originalUrl` stays absolute — it's the
  external "Open ↗" link to tot.page.)
- **`~/.tot` is the only record of anonymous pages.** There is no server-side
  listing. `Config.load/save` guards it (atomic write, corrupt-file preserve).
  Never let a code path silently truncate it.
- **Management is capability-gated.** `/api/tots` returns `capabilities.manage`.
  It's `true` only for the loopback local dashboard (with an ephemeral token);
  the cloud mirror is read-only. Rename/hide/tag are local-metadata mutations.

## Access model (current state)

Cloudflare Access verification in the Worker is **opt-in**, gated on both
`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` being set in `wrangler.jsonc`. They are
currently **empty**, so the dashboard at palapala.me is **publicly readable**.
Set both (and deploy) to require an Access JWT for browser routes. The `/api/sync/*`
routes are always protected by the `SYNC_SECRET` bearer token (+ an Access
service token when Access is on). See `docs/CLOUD_DASHBOARD.md`.

## Build · test · deploy · sync

```bash
pnpm build          # tsc → dist/. The global `tot` is npm-linked here, so this updates it live.
pnpm typecheck      # wrangler types check + tsc --noEmit
pnpm test           # vitest, plain-node env (no workerd; worker globals are stubbed in test/setup.ts)
pnpm cloud:types    # regenerate worker-configuration.d.ts after editing wrangler.jsonc vars
pnpm cloud:deploy   # wrangler deploy (edge plane)
tot dashboard sync  # regenerate + push the mirror manifest (also runs every 5 min via LaunchAgent)
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
