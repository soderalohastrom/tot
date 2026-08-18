# Tot → Pala Rebrand

**Status:** Immediate-work spec. The mirror-route fix (commits `9f86440` +
`7aa5e00`) has already landed. This doc scopes the cosmetic rebrand PR that
lands **on top** of it.

The long-term product vision — owning the publisher end to end — lives in
[`PALAPALA.md`](PALAPALA.md). The migration mechanics live in
[`docs/PALAPALA_TAKEOVER.md`](docs/PALAPALA_TAKEOVER.md). This doc is **just
the rebrand PR**.

---

## 1. What this PR is

The fork asserts its own name.

- **CLI binary:** `tot` → **`pala`** (with `tot` kept as an alias for one minor).
- **Dashboard chrome:** the surface name in titles, headers, buttons, chips,
  settings. The shape stays; the words change.
- **Slogan:** TBD — Scotty picks in the morning discussion.
- **Mark:** TBD — Scotty picks in the morning discussion.

That's it. Everything else stays.

---

## 3. What this PR is **not**

- ❌ **Not a data migration.** The 61 existing slugs, the on-disk files, the
  `~/.tot` registry, the tot.page URLs, the milestone slug
  `FSMFFqxYRXBI-9OlO0_8ZA`, the cloud-brain tot at
  `/Users/soderstrom/Documents/Codex/2026-08-08/co/outputs/cloud-brain-cloudflare-computer.html`
  (8 days old, still in the registry) — **all keep working**. Slugs are the
  durable identity; the rebrand only renames the surface.
- ❌ **Not a domain change.** `palapala.me` is already ours. The cloud
  dashboard URL doesn't move.
- ❌ **Not a `~/.tot` path migration.** That's operational detail, not
  user-facing, and any migration risks breaking external scripts. Leave for a
  future PR.
- ❌ **Not the publisher takeover.** The "thin CLI over `/v1`" posture stays
  for this PR. Owning the publisher is a separate project tracked in
  [`docs/PALAPALA_TAKEOVER.md`](docs/PALAPALA_TAKEOVER.md).

---

## 4. Scope of the PR

A small, mostly-text change. Estimate: ~2 hours of find-replace + a couple of
careful spots.

### 4.1 CLI binary rename
- `package.json`: `bin.tot` → `bin.pala`
- `dist/` rebuild (`pnpm build`)
- README and CLI help: `tot` → `pala` (lowercase, case-sensitive)
- **Keep `tot` as a symlink/alias** for at least one minor so existing scripts
  (LaunchAgents, shell aliases, dashboard buttons) don't break.

### 4.2 Dashboard UI (local + cloud)
- Title bar: `Tot Index` → **`Pala Index`**
- Buttons: `Publish Tot` → `Publish Pala`, `Browse Tots` → `Browse Palas`, etc.
- Settings / owner-page labels: same find-replace.
- **`dashboard/app.js` variables** (the bulk of the work):
  - `state.tots` → `state.palas`
  - `visibleTots()` → `visiblePalas()`
  - `cardMarkup(tot, index)` → `cardMarkup(pala, index)`
  - `tot-card` class → `pala-card`
  - `tot-grid` selector → `pala-grid`
  - `tot-dashboard-view` / `tot-dashboard-reader-width` localStorage keys
    → `pala-dashboard-*`. **Migrate reads** of the old keys for one minor
    so existing browser state survives.
- **Skip** external identifiers like `tot-dashboard-archive` (R2 bucket name)
  and `SYNC_SECRET` and `OWNER_SLUG` — those are operational and changing
  them is out of scope.

### 4.3 Mark + slogan
- Mark: **TBD** — plumeria (Hawaiian, fits the brand) or recolored orange
  tape. Scotty's call.
- Slogan: **TBD** — `"palapala — write it, keep it."` or just `"palapala."`
  Scotty's call.

### 4.4 Docs + hand-off
- `README.md`, `AGENTS.md`: `Tot` → `Pala` find-replace (case-sensitive —
  lowercase is the brand).
- `HANDOFF.md` new section explaining:
  - The rebrand is cosmetic.
  - The slug registry is the durable identity.
  - The 8-day-old tot (`XfWsYPv9Ob3Nwiy5lgA-vg`) and milestone tot
    (`FSMFFqxYRXBI-9OlO0_8ZA`) both keep their slugs; nothing migrates.
  - The mirror-route fix (commits `9f86440` + `7aa5e00`) is the durable
    fix; this PR is the surface polish.
- CHANGELOG entry: `Tot → Pala rebrand. No data migration. Slugs unchanged.
  On-disk ~/.tot path unchanged in this pass; future pass may move to
  ~/.pala.`

---

## 5. The three morning decisions

These block parts of §4. Until they're answered, those parts stay TBD in the PR
description and don't ship.

### 5.1 The mark
**Question:** Plumeria, or keep the orange tape?

- **Plumeria** (recommended) — small, Hawaiian, consistent with the
  `palapala` etymology. Sets the visual language for everything that comes
  after.
- **Recolored orange tape** — keeps continuity with the upstream aesthetic.
  Lowest-risk choice.

### 5.2 Data path
**Question:** Move `~/.tot` → `~/.pala` in this PR?

- **No** (per Hermes' brief). Migrating the data path risks breaking any
  external script that reads from `~/.tot`. Defer to a future PR. The
  rebrand PR only renames surface identifiers; the on-disk config path is
  operational.

### 5.3 Read URL pattern
**Question:** After the mirror-route fix, where do iframes point?

- **`palapala.me/<slug>/<file>.html`** via a future Cloudflare Pages route
  (the work the cloud-pages branch has been building toward).
- Drop the `tot.page/<slug>/<file>.html` link entirely from the dashboard UI.
- The frozen `@hash` URL on `tot.page` survives for any external link; the
  dashboard stops pointing new readers at upstream infra.

Default per Hermes' brief. Confirms with Scotty in the morning.

---

## 6. Acceptance

The PR is done when **all** of these are true:

- [ ] `pala <file>` publishes a new slug on `tot.page` (the upstream API
      still works; the binary rename doesn't break the publish path).
- [ ] `tot <file>` still works (the alias/symlink survives the rename).
- [ ] `pala dashboard` opens `127.0.0.1:4173` with `Pala Index` in the
      title bar (or whatever mark/slogan the morning decides).
- [ ] `palapala.me/<project>` rooms render without "Internal Server Error"
      overlays — Hermes smoke test passes on the milestone tot
      (`FSMFFqxYRXBI-9OlO0_8ZA`).
- [ ] Browser refresh preserves the user's view mode + reader width (the
      localStorage key migration works).
- [ ] `palapala.me/scotty` (the owner slug) renders without errors.
- [ ] `pnpm typecheck` + `pnpm test` + `pnpm lint` all green.
- [ ] No reference to "Tot" remains in any user-facing string (case-sensitive
      grep: `grep -rn "Tot" dashboard/ site/ README.md` returns only
      proper-noun false positives like the migration-doc filenames).

---

## 7. Why now

- The mirror-route fix (commits `9f86440` + `7aa5e00`) just landed — the
  iframe load path is no longer gated on `tot.page` availability.
- The dashboard `<title>` and `<h1>` already say `palapala.me` — the chrome
  rebrand is half done.
- The cloud at `palapala.me/scotty` is live; the admin slug is set.
- "Tot" is the upstream's name. "Pala" is ours.

Slugs are identity. Files are data. The CLI is surface. Don't move data
without a plan; surface can move freely.