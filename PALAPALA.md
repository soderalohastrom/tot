# Palapala — Product Spec

**Status:** North star. The repo is mid-transition from `tot` (thin CLI over
someone else's Workspaces API) to `palapala` (a publishing system we own end to
end). This doc defines the **target product**.

**Siblings:**
- [`REBRAND.md`](REBRAND.md) — the immediate cosmetic rebrand PR (CLI binary
  rename, dashboard chrome, slogan, mark). Lands first.
- [`docs/PALAPALA_TAKEOVER.md`](docs/PALAPALA_TAKEOVER.md) — migration mechanics
  for owning the publisher end to end.
- [`docs/SPEC.md`](docs/SPEC.md) — legacy implementation spec (the
  `tot`-over-Workspaces posture). Kept for provenance.

---

## 1. The one-line pitch

**`pala notes.md` → a living link on `palapala.me` you can update with one command.**

Same shape as the thing you've been calling "tot", same instinct. The difference
is who's behind the curtain: nobody but us.

---

## 2. Why "palapala"

- `palapala` (Hawaiian) — *document; anything written.* Ownable, pronounceable,
  and already yours to say.
- `pala` — the short form. The binary name. The brand. What you say in chat.
- A published document is a **pala**. The catalog is **palapala** (the whole
  practice). Pluralization doesn't need a new word.

```
make me a pala
go look at this pala
how many palas have I published
the pala dashboard
```

The CLI command is `pala <file>`. `tot` stays available as an alias through the
migration window so muscle memory survives.

---

## 3. The product surface

Three primitives, no fourth:

| Primitive | What it does | Lives in |
|---|---|---|
| **Pala** | One published document. Living URL + frozen `@hash` URL. Markdown or HTML. | R2 + D1 row |
| **Project** | A tag on a Pala that scopes a reading room on the dashboard. | `~/.palapala` + manifest |
| **Sync** | Reconciles local `~/.palapala` registry with the cloud dashboard every ~5 minutes. | Worker + LaunchAgent |

Everything else — auth, custom domains per Pala, private rooms, comments,
versions-per-day graphs — is a feature, not a primitive. Features get added
when a primitive can't carry the load.

---

## 4. The hard model (invariants, not aspirations)

These don't change. If a future feature fights one of these, the feature loses.

1. **Link is the keys.** Anyone with the link can view the living URL. A `pala`
   is `open` by default. There is no per-Pala owner credential. (Same posture
   as tot — kept by design; see [`docs/SPEC.md`](docs/SPEC.md) §10.)
2. **Living + frozen URLs.** Every Pala has two URLs:
   - Living: `https://palapala.me/{slug}/{file}` — always the latest, short edge cache, purge on update.
   - Frozen: `https://palapala.me/{slug}/{file}@{sha}` — pinned forever, cached indefinitely.
   These are the only URLs. There is no "draft" link, no "preview" link, no
   "edit" link. You update by running `pala update`.
4. **Content is bytes, not render.** Markdown is served as `text/markdown`. HTML
   is served as `text/html`. No markdown→HTML transform, no templating, no SSR.
   If you want styling, ship CSS in the same directory and Pala will discover
   it via the support-file scan.
5. **Local-first registry.** `~/.palapala` is the source of truth for *which*
   Palas you have. The cloud dashboard is a *projection* of it, refreshed by
   sync. Removing locally removes from sync next run; removing from cloud
   requires `pala remove` (which goes through the API).
6. **Anonymous at launch.** No accounts, no API keys, no login. Auth is added
   only if a primitive breaks (see §11).
7. **The fork is the source.** CLI, server, Worker, R2 schema, dashboard, ops
   scripts — all live in this repo. The "thin CLI over someone else's API"
   posture from the tot era is **gone**. We are the API now.

---

## 5. The hosting topology

Two origins, one Worker pair, one R2 bucket, one D1, one CLI binary.

```
                          ┌───────────────────────────────┐
   pala notes.md ─────────►│  api.palapala.me (Worker A)   │
                          │   POST /v1/...                │
                          │   - mint slug                 │
                          │   - upload assets             │
                          │   - commit document           │
                          │   - return {wsId, docId, slug}│
                          └───────────────────────────────┘
                                       │
                                       ▼
                          ┌───────────────────────────────┐
                          │  R2: palapala-bucket          │
                          │   pages/<slug>/<sha>/<file>   │
                          │   assets/<sha>                │
                          │                               │
                          │  D1: palapala-db              │
                          │   workspaces, documents,       │
                          │   assets tables               │
                          └───────────────────────────────┘
                                       │
                                       ▼
   GET https://palapala.me/{slug}/... ─►│  docs.palapala.me (Worker B) │
                          │   GET /{slug}/{file}            │
                          │   GET /{slug}/{file}@{sha}      │
                          │   GET /<project>   (room shell) │
                          │   GET /api/tots?project=<slug>  │
                          └───────────────────────────────┘
```

**Why two origins:**
- `palapala.me` keeps the *dashboard surface* (landing page, reading rooms at
  `/<project>`, the owner's `/<owner-slug>` room).
- `docs.palapala.me` (or `p.palapala.me` — pick the shorter at deploy time)
  serves the raw published bytes. Cookieless, frame-able from anywhere,
  independent CSP from the dashboard.
- The CLI's `pala publish` and `pala update` write to `api.palapala.me`. The
  CLI's `pala dashboard` reads from `palapala.me` (loopback) or reads the
  local registry directly (the LaunchAgent syncs and the local dashboard is
  already loopback-first).

This is a **content-origin split** that mirrors what tot already does between
`workspaces.plannotator.ai` (API) and `tot.page` (content). We're keeping the
shape; we're swapping the operator.

---

## 6. The CLI — minimum-viable commands

```
pala <file>                 # publish; print living URL + commit + frozen URL
pala update <file|url>      # push new content; same living URL, new version
pala list                   # read ~/.palapala
pala remove <file|url>      # hard-delete; empty shell lingers in D1
pala dashboard              # loopback UI at 127.0.0.1:4173
pala dashboard sync         # reconcile ~/.palapala with palapala.me
pala dashboard backup <dir> # offsite content-addressed archive
pala dashboard restore <dir>
pala dashboard tag <slug> <project>
pala dashboard untag <slug> <project>
pala dashboard tags [<slug>]
pala dashboard configure https://palapala.me
pala dashboard install-agent   # login + 5-min LaunchAgent sync
```

`tot` is kept as a binary alias for one release. The config path migrates from
`~/.tot` to `~/.palapala` on first run, preserving the existing atomic-write
and corrupt-file-preservation guards verbatim.

---

## 7. The dashboard

The dashboard is a **catalog**, not an editor.

- Card and list views, fuzzy search, scoped reading rooms, light/dark, the
  resizable reader panel, hidden Tots, custom display names — all of this
  carries over from tot. No regressions.
- Management chrome (tag, rename, hide, delete) is **loopback-only**, gated on
  `canManage`, behind an ephemeral token that only the local page can mint.
- The cloud dashboard is read-only by default. It is a *projection* of
  `~/.palapala`, not a primary surface. Browser mutations never hit R2/D1
  directly.

What the dashboard is **not**: a CMS. There is no in-browser editor. To edit a
Pala, edit the file and run `pala update`.

---

## 8. Reading rooms (the social surface)

`palapala.me/<project>` is a scoped view of the catalog. The implementation
already exists for tot; it carries over:

- A "project" is a slug on a Pala's tag list (`mise`, `gohappy`, `huh-what`).
  A Pala can be in several rooms.
- `GET /api/tots?project=<slug>` is **server-side filtered** — the browser
  never sees Palas not in the room.
- The owner's own catalog is one more room, addressed by a **secret slug**
  (`OWNER_SLUG`), not a separate surface. Rotation is a `wrangler secret put`,
  no deploy.
- Public/private per-room comes later (see §11).

This is the thing that makes Palapala more than a CLI toy — sending a client
`palapala.me/mise` and having them see only the Palas I want them to see. The
hard part is already built. The migration is repointing, not rebuilding.

---

## 9. The path from tot → palapala

Authoritative plan: [`docs/PALAPALA_TAKEOVER.md`](docs/PALAPALA_TAKEOVER.md).
TL;DR:

| Phase | Effort | What lands |
|---|---|---|
| **0 — Decide** | — | This doc + the open questions below, answered. |
| **1 — Publishing Worker** | M | 8 endpoints in §4 of the takeover, on R2 + D1. ~1–2 focused days. |
| **2 — CLI rebrand** | S | New defaults, `~/.palapala` migration, verify-domain-contract guard, repo sweep. |
| **3 — Migration** | S–M | Republish all existing Tots from the R2 mirror (already in our bucket, hash-verified). New slugs; old `tot.page` links die and we accept that. |
| **4 — Blast radius** | S | Skills (`tot-publish` → `pala-publish`), Keychain entries, LaunchAgent plists, docs, hand-off entry. |

Phase 5 (growth) is not in scope for the takeover.

---

## 10. What we deliberately don't build

Inherited from tot §3 and reinforced here:

- No accounts, no signup, no per-Pala owner credentials.
- No markdown→HTML transformation. Markdown is served raw.
- No build step, no bundler, no SSR. Bytes in, bytes out.
- No custom slugs (server-minted random tokens). Custom *display names* live
  in the dashboard as metadata; they do not touch the URL.
- No mini-Netlify: no config files, no routing rules, no directory deploys.
- No Artifacts, no KV, no coordinator. The "git model" collapses to:
  one R2 object per version + a D1 row mapping slug → current head hash.
  Synchronous. The CLI's poll loop disappears.
- No versioning-of-assets. Assets are content-addressed and immutable; the
  document references them by hash.

If a feature proposal requires any of these, the proposal is wrong.

---

## 11. Things we *might* build later

Listed so they survive context resets, not committed:

- **Per-room Cloudflare Access.** Per-client sign-in for genuinely private
  rooms. Reuses the Access pattern already in place for sync auth.
- **Custom display name UI in the cloud dashboard** (currently localhost-only).
  Requires a write path. Probably not worth it — the local dashboard is where
  you curate, the cloud is where others read.
- **Pinned "start here" Pala per project.** Curation primitive. Cheap if we
  want it.
- **Expiry/revocation.** Delete a Pala → living URL 410s. Frozen URLs survive.
  Takedown stays the admin's hammer; expiry is a softer, opt-in thing.
- **OG image auto-generation in the cloud.** Already on the CLI; not on the
  Worker. Worth doing — every shared link would unfurl.

---

## 12. Open decisions (to lock in Phase 0)

The takeover doc lists five open questions in §8. My recommendations:

| # | Question | Recommendation |
|---|---|---|
| 1 | Content origin: subdomain (A) vs path prefix (B) | **A** — `docs.palapala.me` or `p.palapala.me`. |
| 2 | Binary: `pala` only, or keep `tot` as an alias? | **`pala` + `tot` alias** for one release (≥ v1.0). |
| 3 | Keep `pala login --key`? | **No.** Drop the optional auth. We are anonymous-only at launch. |
| 4 | Reuse `tot-dashboard-archive` R2 bucket? | **New bucket** — `palapala`. Cleaner schema, cheaper regret. |
| 5 | Is there timeline pressure on `tot.page`? | **No signal.** The archive keeps us whole; Phase 1 is on our clock. |

If you disagree with any of these, say so before Phase 1 starts — they shape
the Worker.

---

## 13. Success looks like

A year from now, you open a terminal on a fresh machine, run:

```
brew install palapala
pala notes.md
  ↳ https://palapala.me/aB3xK9q
  commit  e5f6c1a
  frozen  https://palapala.me/aB3xK9q/index.md@e5f6c1a
```

And it just works. The link is yours. The frozen URL is yours. The archive
is in your bucket. The CLI, the server, the Worker, the dashboard, the
reading rooms — all live in one repo, owned end to end, no third party
between you and the bytes.

That's the whole point.