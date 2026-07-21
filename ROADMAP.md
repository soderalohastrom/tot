# ROADMAP

Where the tot dashboard is going. This is the direction doc — read it before
proposing large changes. Detailed engineering specs live in `docs/`; this file
is the "why" and the shape.

## Where we are (2026-07-20)

The cloud dashboard works end to end. Pages published with `tot` are mirrored to
a private R2 bucket by a Cloudflare Worker and served as a searchable reading
room from **palapala.me** — a domain we own, updating itself every five minutes.
It is currently a single, flat, public archive of everything synced.

Recent groundwork that makes the next step cheap:
- The manifest is a **sanitized projection** of `~/.tot` — adding a field is a
  one-line change with a clear privacy boundary.
- Mirror URLs are **same-origin relative paths**, so the same UI works under any
  host or path prefix without CSP surgery.
- `/api/tots` already returns per-request **capabilities** (`manage`), so a
  scoped, read-only variant of the same endpoint is a natural extension.

## The next big thing: client reading rooms

**Goal.** Append a route — `palapala.me/<project>` — that shows one client only
*their* Tots, as a clean read-only page I can hand them. Today everything is one
pile; I want curated, per-client views I can share with a link.

**Why.** The dashboard being on my own domain, always current, is the thing I
love about it. The obvious next move is turning it from "my private archive" into
"a place I send a client to read exactly the pages that concern them" — without
them seeing everyone else's work, and without me rebuilding anything per client.

**The shape** (three moves, each small because of the groundwork above):

1. **Tag Tots with a project.** Add `projects: string[]` to each registry entry
   — a Tot can belong to several client views. A "project" is just a slug
   (`canlis`, `gohappy`). Tag from the local dashboard or a `tot dashboard tag`
   CLI command. Tags ride along in the sanitized manifest.

2. **Serve a scoped view.** `GET /api/tots?project=<slug>` returns only the Tots
   tagged for that client — filtered **server-side**, so a client view never
   ships the rest of the catalog to the browser. The Worker serves the existing
   dashboard shell at `/<project>`; the UI reads the slug from the URL, fetches
   the scoped manifest, hides all management chrome, and shows a project heading.

3. **Control who reads it.** Start with capability URLs (the project slug is the
   key — fine, since the underlying pages are already public-by-link on tot.page).
   Harden later with a per-project Cloudflare Access policy scoped to the client's
   email, reusing the Access pattern the sync path already uses.

**Full engineering detail:** [`docs/CLIENT_VIEWS_SPEC.md`](docs/CLIENT_VIEWS_SPEC.md)
— data model, Worker routes, filtering, access options, branding, phased work
items, and verification. That spec is the authoritative build plan; this section
is the summary.

### Phasing

- **Phase 1 — MVP.** `projects[]` on entries; `tot dashboard tag/untag`; the
  `?project=` server-side filter; `/<project>` serves the shell read-only with a
  project heading. Access = capability URL.
- **Phase 2 — Polish.** Tagging UI in the local dashboard; per-project branding
  (display name, blurb, accent); put the owner root behind Access so only scoped
  views are public.
- **Phase 3 — Private rooms.** Per-project Cloudflare Access policies for genuine
  per-client sign-in; an audit of who-can-see-what.

### Open questions (decide during Phase 1)

- **URL shape — decided:** bare `/<project>` (the owner's original ask, e.g.
  `palapala.me/canlis`), with the closed RESERVED-name guard in the spec so a
  slug can't shadow `/api`, `/mirror`, `/health`, or asset files. `/p/<project>`
  stays parked as the fallback if the guard ever becomes a maintenance burden.
- **Privacy bar — decided 2026-07-21:** client rooms are *curation over
  already-public pages*. Every Tot is already public-by-link on tot.page, so the
  project slug is a filter, not a lock — capability URLs are enough, and the bare
  root `/` stays public too. If two clients ever must not see each other, the
  hedge is a thin landing at `/` with the full master list moved to a private
  slug only the owner knows (never a hand-rolled password form; Cloudflare
  Access for the owner's email is the heavier alternative). This keeps Phase 3
  out of the MVP.
- **Project registry:** derive projects from the union of tags, or keep an
  explicit `projects` metadata map in `~/.tot` (needed anyway once branding
  arrives in Phase 2)?

## Later / maybe

- Search scoped within a project view.
- Per-project ordering / pinning a "start here" Tot.
- A simple index at `/` listing only the projects you're entitled to see.
- Expiry or revocation for a shared client link.

Not committed — parked here so the intent survives context resets.
