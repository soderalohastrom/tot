# AGENTS.md — tot

Guidance for AI coding agents working in this repository. The project documentation
is written in English; keep code comments and docs in English as well.

## Project overview

`@plannotator/tot` is a TypeScript/Node CLI for **git-backed publishing**: it
publishes a Markdown or HTML file to a living `tot.page/<slug>` URL in one
command. `tot update` moves the same link forward (like a branch); every publish
also creates an immutable `@hash` snapshot URL (like a commit). Files are served
byte for byte — no build step, bundler, or config file.

This fork adds a **cloud dashboard**: a Cloudflare Worker + private R2 bucket
that mirrors published pages into a searchable, self-hostable reading room,
currently deployed at **palapala.me**.

There are two planes:

1. **CLI plane** (`src/`, shipped as the `tot` npm binary). Publishes pages via
   the Workspaces API (`https://workspaces.plannotator.ai`), holds the local
   registry in `~/.tot`, and runs `tot dashboard` (local server on
   `127.0.0.1:4173`) and `tot dashboard sync` (pushes a sanitized mirror to the
   Worker).
2. **Edge plane** (`worker/index.ts` + `dashboard/` static assets + R2 bucket
   `tot-dashboard-archive`). Serves the same dashboard UI from a
   content-addressed mirror. Deployed with Wrangler.

The two talk over a small HTTP contract: the CLI PUTs objects and a manifest to
`/api/sync/*`; browsers GET `/api/tots` (manifest) and `/mirror/*` (page content).

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
```

`pnpm prepack` and `pnpm prepublishOnly` chain the full gate:
lint → typecheck → test → build → verify:contract.

**Gotcha:** `worker/index.ts` reads `env.*` vars declared in `wrangler.jsonc`.
After changing `vars`, run `pnpm cloud:types` or `pnpm typecheck` fails with
"Property … does not exist on type 'Env'". Worker-only globals like
`FixedLengthStream` don't exist under vitest's node env — `test/setup.ts` stubs
them; extend the stub if you use more workerd globals.

## Code organization

| Path | Role |
|---|---|
| `src/cli.ts` | Command dispatch (`publish`, `update`, `remove`, `list`, `login`, `dashboard …`), arg parsing, help text. |
| `src/commands.ts` | Publish/update/remove/list/login implementations; HTML asset collection; banner injection. |
| `src/config.ts` | `~/.tot` registry shape (`RegistryEntry`, `DashboardEntryPatch`), `DEFAULT_ENDPOINT`/`DEFAULT_CONTENT_ORIGIN`, atomic guarded load/save. |
| `src/http.ts` | Injectable `HttpClient` abstraction — all network access goes through it. |
| `src/cloud-sync.ts` | Sync/backup/restore. Builds the sanitized manifest; talks to the Worker; macOS Keychain for credentials. |
| `src/dashboard.ts` | Local loopback dashboard server + management API. |
| `src/launch-agent.ts` | macOS LaunchAgent plists for the local server and the 5-minute sync. |
| `src/og.ts` | Open Graph / meta tag injection into HTML. |
| `src/banner.ts` | PNG banner generation via resvg. |
| `src/asset-refs.ts` | parse5-based scan of local browser dependencies an HTML page references. |
| `src/index.ts` | Library surface (re-exports). |
| `worker/index.ts` | Edge Worker: sync auth, manifest, `/mirror/*`, optional Access gate, static-asset fallthrough. |
| `dashboard/` | Dashboard SPA (`app.js`, `app.css`, `index.html`, `reader-layout.js`) — same code local and cloud. |
| `site/` | Editable sources for public tot.page pages (landing, API ref, agent docs) + assets. |
| `scripts/verify-domain-contract.mjs` | Guard that the API origin stays `workspaces.plannotator.ai` and content links stay on `tot.page`. |
| `deploy/hostinger/` | systemd service/timer for non-macOS offsite backups. |
| `docs/` | `CLOUD_DASHBOARD.md` (architecture), `SPEC.md` (product spec), `CLIENT_VIEWS_SPEC.md` (next feature), `REPO_LAYOUT.md`, `LAUNCH.md`. |
| `CLAUDE.md`, `ROADMAP.md`, `HANDOFF.md` | Architecture/invariants, direction, and session log. Read `ROADMAP.md` before proposing large changes. |

## Testing instructions

- Tests live in `test/*.test.ts`, one file per module, run with vitest in a
  **plain node environment** (no jsdom, no workerd) — deliberate, since the code
  exercises real Node fs/os/path behavior.
- `test/setup.ts` stubs workerd-only globals and cleans up `TOT_CONFIG` after
  each test. Config tests must set `TOT_CONFIG` to a temp path so they never
  touch the developer's real `~/.tot`.
- `test/stub.ts` provides `stubHttp(responder)`: a recording `HttpClient` stub.
  Tests inject it rather than hitting a live server — never write a test that
  requires network access or a real `~/.tot`.
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
  names, original URLs, mirror paths, hashes, sizes, timestamps, asset paths —
  and *never* API keys, workspace/document IDs, or local filesystem paths.
  Keep it that way when you add fields.
- **Content-addressed & immutable.** Mirror objects live at
  `tots/<slug>/<contentHash>/<docPath>`; uploads dedupe by SHA-256; an object
  key never changes content. Sync uploads objects *before* the manifest.
- **Same-origin mirror URLs.** Manifest `url` is a relative `/mirror/…` path
  (dashboard CSP is `frame-src 'self'`; absolute cross-origin URLs get blocked).
  `originalUrl` stays absolute — it is the external "Open ↗" link to tot.page.
- **`~/.tot` is the only record of anonymous pages.** There is no server-side
  listing. `Config.load/save` guards it (atomic write, corrupt-file preserve).
  Never let a code path silently truncate it.
- **Management is capability-gated.** `/api/tots` returns `capabilities.manage`
  = true only for the loopback local dashboard (ephemeral token); the cloud
  mirror is read-only. Binding the local dashboard beyond loopback disables
  management entirely.

## Security considerations

- The `SYNC_SECRET` bearer token protects `/api/sync/*` upload routes, always.
  It and the Cloudflare Access service-token credentials live in **macOS
  Keychain** — never write them to `~/.tot`, the manifest, the repo, shell
  history, or plists. On non-macOS hosts, inject `TOT_DASHBOARD_SYNC_TOKEN`,
  `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` from the host secret manager.
- In-Worker Cloudflare Access verification is **opt-in**, gated on both
  `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `wrangler.jsonc`. Both are currently
  empty, so palapala.me is publicly readable. `/health` is always public.
- Published tot.page pages are open: anyone with the link can view, update, or
  delete. There is no private mode.
- The local dashboard binds loopback by default and is not a multi-user
  authenticated service — do not expose it to the internet.
- Do not run `pnpm cloud:deploy`, publish to npm, push, or run live
  `tot update` without explicit approval.
