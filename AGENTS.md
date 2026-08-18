# AGENTS.md — pala

Guidance for AI coding agents working in this repository. The project documentation
is written in English; keep code comments and docs in English as well. For durable
architecture see `CLAUDE.md`; for direction read `ROADMAP.md` before proposing
large changes; `HANDOFF.md` is the running session log (newest first).

## Project overview

`@plannotator/tot` is a TypeScript/Node CLI for **git-backed publishing**: it
publishes a Markdown or HTML file to a living `tot.page/<slug>` URL in one
command. `pala update` moves the same link forward (like a branch); every publish
also creates an immutable `@hash` snapshot URL (like a commit). Files are served
byte for byte — no build step, bundler, or config file.

This fork adds a **cloud dashboard**: a Cloudflare Worker + private R2 bucket
that mirrors published pages into a searchable, self-hostable reading room,
currently deployed at **palapala.me**.

There are two planes:

1. **CLI plane** (`src/`, shipped as the `pala` npm binary — `tot` is kept as
   a one-minor alias). Publishes pages via the Workspaces API
   (`https://workspaces.plannotator.ai`), holds the local registry in `~/.tot`,
   and runs `pala dashboard` (local server on `127.0.0.1:4173`) and
   `pala dashboard sync` (pushes a sanitized mirror to the Worker).
2. **Edge plane** (`worker/index.ts` + `dashboard/` static assets + R2 bucket
   `tot-dashboard-archive`). Serves the same dashboard UI from a
   content-addressed mirror. Deployed with Wrangler.

The two talk over a small HTTP contract: the CLI PUTs objects and a manifest to
`/api/sync/*`; browsers GET `/api/tots?project=<slug>` (scoped manifest) and
`/mirror/*` (page content).

### Client reading rooms (shipped)

The catalog is not one flat public pile. The dashboard host serves **scoped,
read-only rooms** at bare single-segment URLs — `palapala.me/<project>` (`/mise`,
`/gohappy`):

- A "project" is just a slug (`/^[a-z0-9][a-z0-9-]{0,63}$/`) stored as
  `projects: string[]` on each registry entry in `~/.tot`. A Pala can belong to
  several rooms. Tag via `pala dashboard tag|untag <slug|url> <project>` /
  `pala dashboard tags [<slug|url>]`, or the tagging dialog in the local
  dashboard UI. Tags ride along in the sanitized manifest (`projects: string[]`
  on each entry — the internal TypeScript type is still `PublicTot` for cloud
  wire compat; the user-facing concept is "a Pala's rooms").
- The Worker filters **server-side**: `GET /api/tots?project=<slug>` returns
  only the tagged Palas with `capabilities.manage: false`. Bad slug → 400;
  unknown slug → empty list. **An unscoped `/api/tots` (no `?project=`) is a
  404** — no edge route ever lists the whole catalog.
- `GET /<project>` serves the SPA shell (`dashboard/room.html`) for any
  single-segment path not in the Worker's closed `RESERVED_TOP_LEVEL` set
  (`health`, `api`, `mirror`, asset basenames) so a slug can't shadow a real
  route. An unknown slug renders the SPA's empty state.
- The public root `/` is a dead-end landing page (`dashboard/index.html`) — no
  catalog, no links into the rooms.
- The owner's full catalog is a room like any other, behind the `OWNER_SLUG`
  Worker **secret**: `serveScopedManifest` matches every Pala for that slug
  instead of filtering. Unset = no owner room exists; an empty slug never
  matches. Rotate with `wrangler secret put OWNER_SLUG` — the value lives only
  in the secret, never in the repo.

This is **curation, not security**: Palas stay public-by-link on tot.page, and
`/mirror/*` paths are reachable if you already know slug + hash. Room scoping
closes enumeration, not access to a known page.

## Technology stack

- **Language**: TypeScript, strict mode, ESM (`"type": "module"`),
  Node.js >= 20.19. Package manager: **pnpm** (pinned to pnpm@11.9.0).
- **CLI runtime**: Node.js (`dist/cli.js`, built with `tsc -p tsconfig.build.json`).
- **Edge runtime**: Cloudflare Workers (`wrangler`, `nodejs_compat` compat flag),
  R2 for object storage, Workers Static Assets for the dashboard UI.
- **Dashboard UI**: framework-free vanilla JS/CSS in `dashboard/` (same code
  runs local and in the cloud).
- **Key dependencies**: `jose` (Access JWT verification in the Worker),
  `parse5` (HTML asset-reference scanning), `@resvg/resvg-js` (PNG banner
  generation for `--title`).
- **Tooling**: `oxlint` (lint), `oxfmt` (format), `vitest` (test), `wrangler`
  (deploy). No CI — all checks are local.

## Build and test commands

```bash
pnpm install          # deps
pnpm build            # tsc → dist/ (the globally linked `tot` binary updates live)
pnpm typecheck        # wrangler types check + tsc --noEmit
pnpm test             # vitest run (plain node environment)
pnpm lint             # oxlint (lint:fix to auto-fix)
pnpm format:check     # oxfmt check (format to write)
pnpm verify:contract  # checks the domain split stays honest (see below)
pnpm cloud:types      # regenerate worker-configuration.d.ts after editing wrangler.jsonc vars
pnpm cloud:dev        # wrangler dev
pnpm cloud:deploy     # wrangler deploy (edge plane)
pnpm dashboard        # build + run the local dashboard
pala dashboard sync   # regenerate + push the mirror manifest (also runs every 5 min via LaunchAgent)
```

`pnpm prepack` runs build + verify:contract; `pnpm prepublishOnly` chains the
full gate: lint → typecheck → test → build → verify:contract.

**Gotchas:**

- `worker/index.ts` reads `env.*` vars declared in `wrangler.jsonc`. After
  changing `vars`, run `pnpm cloud:types` or `pnpm typecheck` fails with
  "Property … does not exist on type 'Env'".
- Worker-only globals like `FixedLengthStream` don't exist under vitest's node
  env — `test/setup.ts` stubs them; extend the stub if you use more workerd
  globals.
- `pnpm-workspace.yaml` exists because pnpm 11 blocks postinstall scripts by
  default and `esbuild` (a vitest transitive dep) needs one approved.
- The `pala` binary on the owner's machine is `npm link`'d to this working copy,
  so `pnpm build` immediately changes the live command. (`tot` is a sibling
  symlink kept as an alias.)

## Code organization

| Path | Role |
|---|---|
| `src/cli.ts` | Command dispatch (`publish`, `update`, `remove`, `list`, `login`, `dashboard …` incl. `sync`/`backup`/`restore`/`tag`/`untag`/`tags`/`install-agent`), arg parsing, help text. |
| `src/tot-shim.ts` | Tiny entrypoint that re-runs `cli.ts` `main()` — invoked by the `tot` bin symlink to keep the legacy alias working through the rebrand window. |
| `src/commands.ts` | Publish/update/remove/list/login implementations; HTML asset collection; OG/banner injection. |
| `src/config.ts` | `~/.tot` registry shape (`RegistryEntry` incl. `projects`, `DashboardEntryPatch`), `DEFAULT_ENDPOINT`/`DEFAULT_CONTENT_ORIGIN`, atomic guarded load/save. |
| `src/projects.ts` | Project-slug pattern + `isProjectSlug`/`normalizeProjectSlug`/`normalizeProjects`. The Worker mirrors the regex as a constant (it does not import from `src/`) — **keep the two in sync**. |
| `src/http.ts` | Injectable `HttpClient` abstraction — all network access goes through it. |
| `src/cloud-sync.ts` | Sync/backup/restore. Builds the sanitized manifest; talks to the Worker; macOS Keychain for credentials. |
| `src/dashboard.ts` | Local loopback dashboard server + management API. Serves the SPA shell (`room.html`) at `/` locally — `index.html` is the cloud landing page and is never served here. The on-the-wire shape returned at `/api/tots` is still `{ tots: [...] }` for back-compat with the cloud; internal type is `DashboardPala`. |
| `src/launch-agent.ts` | macOS LaunchAgent plists for the local server and the 5-minute sync (`StartInterval` 300s; tags reach the cloud in 0–5 min unless you run `tot dashboard sync` by hand). |
| `src/og.ts` | Open Graph / meta tag injection into HTML. |
| `src/banner.ts` | PNG banner generation via resvg (auto `og:image` when `--title` is passed without `--image`). |
| `src/asset-refs.ts` | parse5-based scan of local browser dependencies an HTML page references. |
| `src/index.ts` | Library surface (re-exports). |
| `worker/index.ts` | Edge Worker: sync auth, scoped manifest, `/mirror/*`, room routing (`/` → `index.html`, `/<project>` → `room.html`), optional Access gate, static-asset fallthrough. |
| `dashboard/` | Dashboard SPA — `index.html` (public landing page), `room.html` (the SPA shell), `app.js`, `app.css`, `reader-layout.js`. Same code local and cloud. |
| `site/` | Editable sources for public tot.page pages (landing, API ref, agent docs) + assets. |
| `scripts/verify-domain-contract.mjs` | Guard that the API origin stays `workspaces.plannotator.ai` and content links stay on `tot.page`. |
| `deploy/hostinger/` | systemd service/timer for non-macOS offsite backups. |
| `docs/` | `CLOUD_DASHBOARD.md` (architecture), `SPEC.md` (product spec), `CLIENT_VIEWS_SPEC.md` (reading rooms — Phase 1 shipped, Phase 2 partially), `PALAPALA_TAKEOVER.md` (scoping for self-hosting the publishing backend — decision pending), `REPO_LAYOUT.md`, `LAUNCH.md`. |
| `CLAUDE.md`, `ROADMAP.md`, `HANDOFF.md` | Architecture/invariants, direction, and session log. |

## Testing instructions

- Tests live in `test/*.test.ts`, one file per module, run with vitest in a
  **plain node environment** (no jsdom, no workerd) — deliberate, since the code
  exercises real Node fs/os/path behavior.
- `test/setup.ts` stubs workerd-only globals (`FixedLengthStream`) and cleans up
  `TOT_CONFIG` after each test. Config tests must set `TOT_CONFIG` to a temp
  path so they never touch the developer's real `~/.tot`.
- `test/stub.ts` provides `stubHttp(responder)`: a recording `HttpClient` stub.
  Tests inject it rather than hitting a live server — never write a test that
  requires network access or a real `~/.tot`.
- `test/worker.test.ts` stubs Cloudflare Assets canonicalization: any
  non-literal asset path 404s, so a route that leans on `html_handling`
  redirects fails loudly in tests instead of in production.
- The npm package only ships `dist/` + `dashboard/` (`package.json` `files`).

## Code style guidelines

- Formatting: **tabs**, print width 100 (`oxfmt`). Run `pnpm format` before
  committing. `site/**/*.html` is excluded from formatting.
- Lint: oxlint with `correctness` at error, `suspicious`/`perf` at warn. Unused
  variables must be prefixed `_`. Non-null assertions and `any` are allowed.
- TypeScript: strict, `noUnusedLocals`/`noUnusedParameters`, ESM with
  `verbatimModuleSyntax` — use `import type` for type-only imports, and `.js`
  extensions on relative imports (NodeNext-style, resolves to the compiled
  output).
- Match existing style: surgical, minimal changes; comments explain *why* in
  short sentences; no premature abstraction.
- Keep `CLAUDE.md` current when you change an invariant.

## Invariants (do not break without saying so)

- **Sanitized manifest.** The public manifest (`/api/tots`) carries display
  names, original URLs, mirror paths, hashes, sizes, timestamps, asset paths,
  project tags — and *never* API keys, workspace/document IDs, or local
  filesystem paths. Keep it that way when you add fields.
- **Content-addressed & immutable.** Mirror objects live at
  `tots/<slug>/<contentHash>/<docPath>`; uploads dedupe by SHA-256; an object
  key never changes content. Sync uploads objects *before* the manifest.
- **Same-origin mirror URLs.** Manifest `url` is a relative `/mirror/…` path
  (dashboard CSP is `frame-src 'self' https://tot.page`; absolute cross-origin
  URLs get blocked). `originalUrl` stays absolute — it is the external
  "Open ↗" link to tot.page.
- **No unscoped catalog on the edge.** `/api/tots` with no `?project=` is a 404
  in the Worker (not 401 — don't confirm there is something to unlock). Every
  cloud read is scoped to a room, including the owner's. Restoring an unscoped
  listing re-exposes the whole mirror to `curl`.
- **`~/.tot` is the only record of anonymous pages.** There is no server-side
  listing. `Config.load/save` guards it (atomic write, corrupt-file preserve).
  Never let a code path silently truncate it.
- **Management is capability-gated.** `/api/tots` returns `capabilities.manage`
  = true only for the loopback local dashboard (ephemeral token); the cloud
  mirror and every room are read-only. Binding the local dashboard beyond
  loopback disables management entirely. Tagging UI is gated on `canManage`, so
  a client viewing a room never sees management chrome.
- **Assets serve literal paths.** `wrangler.jsonc` sets `html_handling: "none"`,
  and the Worker names the file for each route (`/` → `index.html`,
  `/<project>` → `room.html`) via `serveAsset()`. The default
  `auto-trailing-slash` mode 307s `/index.html` → `/` and `/room.html` →
  `/room`; both have already caused shell-routing redirect bugs in production.
  Don't rely on canonicalization, and don't add a route that fetches a bare
  path.

## Security considerations

- The `SYNC_SECRET` bearer token protects `/api/sync/*` upload routes, always.
  It and the Cloudflare Access service-token credentials live in **macOS
  Keychain** — never write them to `~/.tot`, the manifest, the repo, shell
  history, or plists. On non-macOS hosts, inject `TOT_DASHBOARD_SYNC_TOKEN`,
  `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` from the host secret manager.
- `OWNER_SLUG` is a Worker secret (declared alongside `SYNC_SECRET` in
  `wrangler.jsonc`); its value lives only in Cloudflare, never in the repo.
- In-Worker Cloudflare Access verification is **opt-in**, gated on both
  `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `wrangler.jsonc`. Both are currently
  empty, so palapala.me is publicly readable; turning Access on would put a
  login in front of the client rooms too, which is why rooms are gated by slug
  scoping instead. `/health` is always public.
- Published tot.page pages are open: anyone with the link can view, update, or
  delete. There is no private mode.
- Mirrored HTML is served with a CSP sandbox (`sandbox allow-scripts
  allow-forms; base-uri 'none'`); the dashboard shell sends a restrictive CSP,
  `referrer-policy: no-referrer`, and `x-frame-options: DENY`.
- The local dashboard binds loopback by default and is not a multi-user
  authenticated service — do not expose it to the internet.
- Do not run `pnpm cloud:deploy`, publish to npm, push, or run live
  `tot update` without explicit approval.
