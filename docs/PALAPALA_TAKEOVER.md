# Palapala Takeover — Scoping & Phased Plan

**Status:** scoping only. No code written. Decision pending.
**Date:** 2026-07-25

Goal: fully detach from the original author's infrastructure
(`workspaces.plannotator.ai` API + `tot.page` content origin) and re-own the
product as **palapala** (Hawaiian: "document") — "make me a palapala", "go look
at this palapala" — published to `palapala.me`, grown in our own direction.

---

## 1. Why — the actual risk

The risk is **not** "tot.page expires and I lose my archive." It is larger and
smaller than that at the same time:

- **Already mitigated today: content loss.** `tot dashboard sync` downloads
  every page's full bytes (document + all assets) into the private R2 bucket
  `tot-dashboard-archive` (`src/cloud-sync.ts:235` downloads `entry.url`;
  assets at `:248`). `tot dashboard backup`/`restore` give offsite copies. The
  archive survives the author disappearing.
- **Not mitigated: publishing.** This repo contains **no publishing server**.
  SPEC.md is explicit: *"tot is a thin CLI over `/v1`. No new Worker, no KV."*
  The backend — Workspaces API, the tot.page content-serving Worker, D1, R2,
  versioning — lives in the author's private monorepo, closed-source. If
  `workspaces.plannotator.ai` goes away, **no new pages can be published and
  no existing page can be updated**, regardless of the domain.
- **Not mitigated: living URLs.** Every shared `tot.page/<slug>` link (and
  every frozen `@hash` link) dies with the author's service. We cannot
  redirect a domain we don't own.

So the takeover question is really: *do we want "make me a palapala" to keep
working under our own domain for years?* If only the archive matters, we are
already done. If living links and future publishing matter, do the work below.

## 2. What makes this cheap

- **The CLI is already origin-agnostic.** `src/config.ts:9-11` defines
  `DEFAULT_ENDPOINT` / `DEFAULT_CONTENT_ORIGIN` as data; `src/cli.ts:76`
  exposes `--endpoint`. Every command flows through `cfg.endpoint` /
  `cfg.contentOrigin` — the client side of the takeover is mostly a defaults
  change plus rebrand, not a rewrite.
- **The API surface is tiny and fully typed in the client.** ~8 endpoints, all
  in `src/http.ts:95-257` (see §4).
- **The R2 mirror is a complete content-addressed backup.** Migration is a
  re-publish loop over bytes we already hold, not a scrape of a dying service.
- **`scripts/verify-domain-contract.mjs` inverts into a guard** that the new
  domain split stays honest.

## 3. What we deliberately do NOT rebuild

The original platform is a multi-user, multi-document Workspaces system with a
coordinator, access gates, and Cloudflare **Artifacts** for async version
checkpointing (the reason the CLI polls until `version != null`). The tot use
case is a thin anonymous slice of that. We rebuild only the slice:

- Anonymous, open-by-link pages only (link-is-the-keys; anyone with the link
  can view/update/delete — same model as today).
- One document per workspace plus flat support assets.
- **No Artifacts.** The "git" model collapses to: one R2 object per version
  keyed by SHA-256 + a D1 row mapping slug → current head hash. Living URL
  reads the pointer; `@hash` URL reads the immutable object directly.
  Versioning becomes synchronous, so the CLI's poll succeeds on the first
  check. Standard, boring Cloudflare primitives — a simplification, not a
  loss.
- Rate limits via Cloudflare firewall rules; takedown = delete D1 row + R2
  objects (SPEC.md §6 already specced the numbers: 120/min reads, 10/min
  creates, 60/min writes per IP).

## 4. The server contract to reimplement

From `src/http.ts` (all under a new API origin, e.g. `api.palapala.me`):

| Endpoint | Used by |
|---|---|
| `POST /v1/documents {kind, body}` | bare markdown/HTML publish (one-shot) |
| `POST /v1/workspaces` | asset-carrying publish; early slug mint for auto og:image |
| `PUT /v1/workspaces/{wsId}/assets/{assetPath}` | support-file upload (images, css, js, mp4; 10 MB ceiling) |
| `POST /v1/workspaces/{wsId}/documents` | commit HTML after assets exist |
| `GET /v1/workspaces/{wsId}/documents/{docId}` | publish poll + update pre-read |
| `PUT /v1/workspaces/{wsId}/documents/{docId}` | `tot update` |
| `DELETE /v1/workspaces/{wsId}/documents/{docId}` | `tot remove` |
| `GET /v1/me` | `tot login --key` verification (optional; may stub) |

Response shapes the CLI depends on: create returns `{workspace: {id, slug},
document: {id, doc_path, version, file_url, share_url}}`; `file_url` is null
until the first version lands; `version` null until first checkpoint (ours is
never null after the write returns). Limits to mirror: body ≤ 1.5 MB (422),
asset ≤ 10 MB (422).

Content serving on the content origin:

```
GET /{slug}[/{path}]          → head pointer → R2 bytes, content-type by kind,
                                Cache-Control: public, max-age=60,
                                Cache-Tag: ws:{id} (purged on update)
GET /{slug}/{path}@{hash}     → immutable R2 object, cache-forever
GET /{slug}/{assetPath}       → support assets (hash-addressed, immutable)
```

### Data model (new)

- **D1**: `workspaces(id, slug, created_at)`,
  `documents(id, ws_id, doc_path, kind, head_hash, deleted_at)`,
  `assets(ws_id, path, sha256, content_type, size)`.
- **R2** (reuse or sibling of the existing bucket):
  `pages/<slug>/<sha256>/<docPath>` for versions, `assets/<sha256>` for
  support bytes. Immutable, content-addressed — same discipline as the mirror.
- Slug minting: ~22-char random token via Web Crypto (matches SPEC §3).

## 5. The one design decision to make first: where pages are served

palapala.me currently serves reading rooms at bare `/<project>` paths behind a
closed `RESERVED_TOP_LEVEL` set. Published page slugs would collide with that
namespace. Options:

- **A. Subdomain content origin (recommended).** `docs.palapala.me` (or
  similar) serves `/<slug>/<path>`. Preserves the original's cookieless-origin
  isolation argument, keeps the room router untouched, mirrors the existing
  two-origin split the CLI already understands (`endpoint` vs
  `contentOrigin`). Cost: one more route/DNS entry.
- **B. Path prefix on the same host.** `palapala.me/p/<slug>`. Single host,
  but adds a route to the room Worker, changes URL shape, and weakens the
  origin-isolation story.

Decide before writing the Worker; it shapes routing, the CSP, and the URL the
CLI prints.

## 6. Phased plan

**Phase 0 — Decision (this doc).** Confirm scope: rebrand + self-host +
migrate. Pick option A/B for content origin. Pick names: npm package
(`@soderstrom/palapala`?), binary (`palapala`; optionally ship a `tot` alias
during transition), config file (`~/.palapala`).

**Phase 1 — Publishing Worker (the bulk, ~1–2 focused days).**
New Worker (separate from the dashboard Worker) implementing §4 against
R2 + D1: slug minting, synchronous versioning, assets, living + frozen reads,
cache tags + purge on update, firewall rate-limit rules, takedown script.
Acceptance: the unmodified CLI, pointed at it with `--endpoint`, passes its
full publish/update/remove/list flow; `pnpm test` in the CLI repo still green
against a stubbed version of the new server.

**Phase 2 — CLI rebrand + re-point.**
- `src/config.ts`: new defaults; config path `~/.palapala` with
  import-on-first-run from `~/.tot` (keep the atomic-write and
  corrupt-file-preservation guards verbatim).
- `src/cli.ts`: help text, branding; keep `--endpoint` as the escape hatch.
- `src/cloud-sync.ts`: download URLs now resolve against the new content
  origin (old entries keep their tot.page `url` for fetching until migrated).
- `scripts/verify-domain-contract.mjs`: invert — API origin is
  `api.palapala.me`, content links on the new content origin.
- package.json rename; dist rebuild; re-`npm link`.
- Test sweep (~238 `tot.page`/`plannotator` hits across 27 files, mostly docs
  and fixtures).

**Phase 3 — Migration of existing pages.**
For each entry in the old `~/.tot` registry: pull bytes from the R2 mirror
(not from tot.page — the mirror is authoritative and hash-verified), publish
to the new backend under a **new** slug, rewrite absolute `tot.page`
references inside the HTML (og:url, og:image banners), record the new
`{wsId, docId, slug, url}` in `~/.palapala`, then `dashboard sync`.
Honest caveats: old tot.page links die no matter what (we don't own the
domain); anyone holding old links needs the new URL; frozen `@hash` URLs baked
into old documents break.

**Phase 4 — Blast-radius sweep.**
- User skills: `~/.agents/skills/tot-publish/SKILL.md` (~40 refs — rename to
  `palapala-publish`, new URLs), `sim-screenshot-observation` (5 tot.page
  example references), `html-diagram` (one cosmetic SVG label).
- Local ops: LaunchAgent plists renamed, Keychain entries (keyed by host —
  palapala.me creds already exist), wrangler worker name, R2 bucket naming.
- Docs: README, SPEC, LAUNCH, CLOUD_DASHBOARD, AGENTS.md, CLAUDE.md, `site/`
  pages (these are themselves published tot pages — republish per Phase 3).
- HANDOFF.md entry when done.

**Phase 5 — Growth in our own direction.** Only after 1–4: custom slugs,
private rooms, edit UI, whatever ROADMAP wants next. Out of scope here.

## 7. Effort summary

| Piece | Size |
|---|---|
| Phase 1: publish+serve Worker (8 endpoints, R2+D1, cache tags) | M — the bulk |
| Phase 2: CLI defaults, rebrand, config migration, contract guard | S |
| Phase 3: migration loop + HTML link rewrite | S–M |
| Phase 4: skills + docs + ops sweep | S |
| DNS, firewall rules, secrets, deploy | S |

## 8. Open questions for decision time

1. Content origin: subdomain (A) vs path prefix (B)? — recommendation: A.
2. Binary name `palapala` only, or keep `tot` as an alias for one release?
3. Keep `tot login --key` at all? Anonymous-only is the current model; a stub
   `GET /v1/me` keeps the code path without building auth.
4. Reuse the existing `tot-dashboard-archive` bucket for page storage, or a
   separate bucket? (Separate is cleaner; reuse is cheaper.)
5. Timeline pressure: is there any signal about the author's plans for
   tot.page? If the domain is stable, Phase 1 can wait; the archive keeps us
   whole in the meantime.
