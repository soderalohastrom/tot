# Path B Shape Proposal — Palapala publishing

**Author:** Hermes · **Date:** 2026-08-18 · **Status:** co-sign with Roman · awaiting Scotty's three morning decisions
**Status of Path A:** smoke test green. Local-mirror iframe reads 64 slugs cleanly; `palapala.me/mirror/<slug>/<sha256>/<file>.html` returns 200 for the four TOTs I just sampled. Path A is real.
**Why this matters now:** the upstream `tot.page` edge is still 500s on direct reads. Path B is the durable fix — the fork stops depending on someone else's Cloudflare account and is fully self-hosted.

---

## The shape, in one paragraph

Path B replaces the upstream publishing edge (`workspaces.plannotator.ai` + `tot.page` content origin) with a single Cloudflare Worker that owns the read surface for published TOTs and writes to R2 (immutable, content-addressed blob storage) + D1 (slugs → current head hash + metadata). The Worker serves `palapala.me/<slug>/<file>.html` from R2 by looking up the slug's current head hash in D1, hashes incoming content with SHA-256 to get a stable, immutable key, and returns the blob. Anonymous-by-link is the access model (link-is-the-key, anyone with the URL can view/update/delete — same as today). The CLI's existing `--endpoint` escape hatch already routes everything through `cfg.endpoint`; the new worker is a new default value, and the fork owns the URL.

---

## The three options (in priority order)

| | Read URL | Worker surface | How slugs are served | What the dashboard iframe reads |
|---|---|---|---|---|
| **A (recommended)** | `docs.palapala.me/<slug>/<file>.html` | One Worker against R2+D1, hosted on a subdomain of palapala.me as `palapala-publisher.scott-c93.workers.dev` (the new Worker name; `tot-dashboard.scott-c93.workers.dev` is the dashboard Worker, kept separate for clearer audit trail) | Worker reads D1 for slug→head, reads R2 for `<slug>/<sha256>/<file>` | Iframe → `entry.cloudUrl`, which becomes `docs.palapala.me/<slug>/<file>.html` |
| **B** | `palapala.me/p/<slug>/<file>.html` | Same Worker, but routed under a path prefix on the existing `palapala.me` host | Same D1 + R2 lookup, but the room router needs a `RESERVED_TOP_PREFIX` entry for `p` | Iframe → `entry.cloudUrl`, which becomes `palapala.me/p/<slug>/<file>.html` |
| **C** | `palala.me/<slug>/<file>.html` (no prefix, no subdomain) | Worker + a routing rule that lets our slugs live at the bare `palapala.me/<slug>` path | Same D1 + R2 lookup, but reserved against a list of existing room slugs | Iframe → `entry.cloudUrl`, which becomes `palapala.me/<slug>/<file>.html` |

**Default recommendation: A (subdomain).** Roman's take (already in `PALAPALA_TAKEOVER.md` §5) and mine converge. The same-origin mirror URL pattern stays clean: `docs.palapala.me` is a different host from the dashboard at `palapala.me`, and the existing two-origin split (`endpoint` vs `contentOrigin`) the CLI already understands maps naturally to this. CSP is a single rule, not a path-prefix exception. DNS is one `CNAME` record. There's a third reason it's the right default: **subdomain leaves the bare `palapala.me` host untouched for the dashboard feature work Roman is doing — the OWNER_SLUG scoping, the room router, the `~/{project}` rooms all keep their shape.** A or B both preserve that; only A and B do.

---

## What each option changes (in the order Roman will care about)

| | DNS | Routing | CSP | `RESERVED_TOP_LEVEL` / prefix conflict | Surface change for Scotty's reading-rooms |
|---|---|---|---|---|---|
| **A** | `CNAME docs.palapala.me → tot-dashboard.scott-c93.workers.dev` | one new Worker route, no room-router change | simple `frame-src docs.palapala.me` | none — bare `palapala.me` untouched | none |
| **B** | none | one new route, room-router has to add a `p` prefix exception | simple `frame-src 'self'` | one reserved prefix to add to `RESERVED_TOP_LEVEL` | reading-rooms gain a `palapala.me/p/<slug>` shadow URL — not breaking but a duplicate-shape path |
| **C** | none | room-router has to compare every slug against the `RESERVED_TOP_PREFIX` set on every request | simple `frame-src 'self'` | every existing room slugs has to be added to the reserved set | reading-rooms lose their bare path if any slug conflicts — biggest blast radius |

---

## The worker surface (the part Roman and I converge on)

| Endpoint | Verbs | Read/Write | Bound to |
|---|---|---|---|
| `POST /v1/documents {kind, body}` | bare markdown/HTML publish (one-shot) | W | R2 (key: `pages/<slug>/<sha256>/<docPath>`) + D1 (slug pointer) |
| `POST /v1/workspaces` | asset-carrying publish; early slug mint for og:image | W | same as above |
| `PUT /v1/workspaces/{wsId}/assets/{assetPath}` | support-file upload (10 MB ceiling) | W | R2 (key: `assets/<sha256>`) |
| `POST /v1/workspaces/{wsId}/documents` | commit HTML after assets exist | W | same as POST /v1/documents |
| `GET /v1/workspaces/{wsId}/documents/{docId}` | publish poll + update pre-read | R | D1 + R2 |
| `PUT /v1/workspaces/{wsId}/documents/{docId}` | update | W | R2 (new sha256) + D1 (new head) |
| `DELETE /v1/workspaces/{wsId}/documents/{docId}` | remove | W | D1 (mark deleted) + R2 (drop immutable) |
| `GET /v1/me` | (optional) `tot login --key` verification | R | anonymous-only is the current model; a stub keeps the code path without building auth |

The CLI side is already origin-agnostic (`src/config.ts:9-11` defines `DEFAULT_ENDPOINT` / `DEFAULT_CONTENT_ORIGIN` as data; `src/cli.ts:76` exposes `--endpoint`). Every command flows through `cfg.endpoint` / `cfg.contentOrigin`. The new worker is a new default value, plus a rebrand. Migration is mostly a defaults change plus a re-point.

---

## The 8 endpoints — keep them all, but make them synchronous

Today's `@plannotator/tot` server is async (Artifacts for checkpointing) — that's why the CLI polls until `version != null`. The fork's worker is **synchronous versioning**: one R2 object per version keyed by SHA-256 + a D1 row mapping slug → current head hash. Living URL reads the pointer; `@hash` URL reads the immutable object directly. The CLI's poll succeeds on the first check. That's a **simplification, not a loss** — we don't need Artifacts for the anonymous use case. The version isn't null after the write returns, so the CLI never polls.

---

## The 3 morning decisions (Scotty's call, not ours)

1. **Mark.** Plumeria (Hawaiian, fits `palapala`) or recolored orange tape? The plumeria SVG can be inline; the orange tape recolor is a CSS variable change. Either is cheap. **Default to plumeria** if no preference — it's a one-time asset decision.
2. **Data path.** Leave `~/.tot` alone (operational, not user-facing) or migrate to `~/.pala`? **Default to leave it** until the migration script is audited. The Path A brief said it stays; Path B doesn't have to push the rename. Migration is a one-time find-replace + a `pm2` restart of the local dashboard.
3. **Read URL pattern.** This proposal recommends A (`docs.palapala.me/<slug>/<file>.html`). Path B's worker shape is independent of this choice (the Worker can serve A, B, or C in the same code), but the cloudUrl in the registry and the iframe `src` URL in the dashboard change based on this. **Default to A** unless Scotty wants the bare-path simplicity of C.

---

## The 5 known unknowns, asked now (not when the worker is half-built)

1. **Reuse the existing `tot-dashboard-archive` R2 bucket** for page storage, or a separate bucket (`palapala-pages`)? Separate is cleaner; reuse is cheaper. **Default: separate** — the dashboard's mirror is for *content*; the new bucket is for *publishing*. Two intents, two buckets.
2. **Keep `tot login --key` at all?** Anonymous-only is the current model; a stub `GET /v1/me` keeps the code path without building auth. **Default: stub** — don't build real auth, but don't remove the path either.
3. **Binary name `palapala` only, or keep `tot` as an alias for one release?** The rebrand PR (Path A) shipped `tot` as a thin shim. **Default: keep `tot` as an alias for one release** — existing scripts don't break, new scripts use `pala`. Drop the alias in 90 days.
4. **Cache-Control: `public, max-age=60, Cache-Tag: ws:{id}`** for living URLs, **cache-forever** for `@hash` URLs. The frozen hash URLs are content-addressed, so any cache hit is correct by construction. The living URL has a 60s window before re-validating with the Worker. **Default: yes, exactly this.**
5. **Takedown = delete D1 row + R2 objects** (Path A spec §6). Simple, irreversible, no soft-delete. **Default: yes.** The CLI has a `pala remove` command (mirror of today's `tot remove`).

---

## What I'll build after the morning decisions

One Worker (`palapala-publisher`), against one R2 bucket (`palapala-pages`) + one D1 database (`palapala-registry`), eight endpoints, anonymous, sync versioning, content-addressed. Estimated effort: **M, the bulk of Path B (1–2 focused days)** per the existing `PALAPALA_TAKEOVER.md` plan.

The CLI defaults change to `pala` binary publishing to the new endpoint. The fork's `soderalohastrom/tot` repository's `package.json` becomes `palapala` (or `@soderstrom/palapala` if you want the npm name; the binary stays `pala`). The dashboard's iframe `src` flips from `entry.url` (broken `tot.page`) to `entry.cloudUrl` (the new palapala.me mirror). The `tot` alias on the binary is dropped in 90 days, then renamed across skills.

Path B ships when:
1. The three morning decisions land (mark, data path, read URL).
2. Roman's DNS prep is staged (subdomain `docs.palapala.me` is the default; if A is picked, he stages the CNAME).
3. The CLI rebrand (Phase 2 in `PALAPALA_TAKEOVER.md`) is staged but not pushed.

After the worker is up, the migration loop (Phase 3) re-publishes the 64 existing slugs from the local mirror (not from `tot.page` — the mirror is authoritative and hash-verified) under the new endpoint. **Slugs are durable identity** — same slug value, new endpoint. Frozen `@hash` URLs survive.

---

## What I'm NOT doing in this proposal

- I'm not designing the CLI rebrand details (Phase 2). That's a separate PR after Path B lands.
- I'm not redesigning the dashboard feature work. The local dashboard's mirror route, sync watcher, tag-bulk CLI are the surface; the new `cloudUrl` field in the registry is the only dashboard-facing change for Path B.
- I'm not preempting Path A's commit. Path A is real (smoke test green); this proposal is the read-side next step.
- I'm not asking for a final `pala cloud` interface design yet. The 8 endpoints above are the surface; the CLI side comes from the existing `pala` binary.

---

**Ready for co-review with Roman. Once Roman signs off, the proposal goes to Scotty for the three morning decisions and the rest lands as one PR per option branch.**

— Hermes, w11:pC
