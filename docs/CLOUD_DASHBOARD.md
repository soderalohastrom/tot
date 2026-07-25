# Tot Dashboard Cloud Mirror

The cloud dashboard complements the localhost dashboard; it does not replace it.

## Architecture

- **Worker Static Assets** serves the existing `dashboard/` interface.
- **Worker API** optionally validates Cloudflare Access JWTs before serving the dashboard, manifest, or mirrored pages (see below).
- **Private R2 bucket** (`tot-dashboard-archive`) stores immutable, content-addressed HTML and registered assets.
- **Sync API** requires a 256-bit Worker secret (`SYNC_SECRET`) stored in macOS Keychain, plus a path-scoped Cloudflare Access service token when Access is enabled.
- **Local registry** (`~/.tot`) remains the source of which Tots belong in the current catalog.
- **Manifest snapshots** are additive. Removing a Tot from the current manifest does not delete mirrored content.

### Reading rooms, and what the public root shows

Everything readable on the edge is scoped to a room. There is no unscoped catalog:

| Route | Serves |
|---|---|
| `/` | `dashboard/index.html` — a landing page. No catalog, no links into the rooms. |
| `/<project>` | `dashboard/room.html` (the SPA shell) for any non-reserved single-segment slug. The UI reads the slug and fetches its scoped manifest; an unknown slug renders the empty state. |
| `/api/tots?project=<slug>` | Only Tots tagged with that slug, filtered **server-side**. |
| `/api/tots` (no `project`) | `404`. Restoring an unscoped listing re-exposes the whole mirror to a bare `curl`. |
| `/mirror/*` | Mirrored content by content-addressed path. Unlisted, but reachable if you already hold the path. |

The owner's own catalog is `OWNER_SLUG` — a **secret** holding an unguessable project slug that `serveScopedManifest` matches against *every* Tot instead of filtering by tag. It is a normal room in every other respect, including `capabilities.manage: false`. Unset means no owner room exists; an empty slug never matches. Rotate without a deploy:

```bash
printf '%s' 'new-slug' | npx wrangler secret put OWNER_SLUG   # must match [a-z0-9][a-z0-9-]*
```

This is **curation, not secrecy**. Tots stay public-by-link on tot.page, and mirror paths stay fetchable to anyone holding one. The gate closes *enumeration* — nobody browses or curls their way to the catalog.

> **Assets serve literal paths.** `html_handling` is `"none"` and the Worker names the file for each route. The default mode 307s `/index.html` → `/` and `/room.html` → `/room`; the first broke the `/<project>` route once, and the second turned the shell fetch into a redirect loop. Don't add a route that fetches a bare path.

### Cloudflare Access is opt-in (and currently off)

In-Worker Cloudflare Access verification is gated on **both** `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` being set in `wrangler.jsonc`:

- **Both set** → *all* browser routes require a valid Access JWT; a missing/invalid token returns `401`.
- **Either empty (current default)** → no in-Worker check. Room scoping above is what limits reads.

Note the interaction: Access is all-or-nothing across browser routes, so enabling it would put a sign-in in front of the client rooms too. That is why the rooms are gated by slug scoping instead.

`/health` is always public and reports whether Access is configured (`authConfigured`). The `/api/sync/*` routes are **always** protected by the `SYNC_SECRET` bearer token, independent of the Access setting.

### Same-origin mirror URLs

The manifest `url` field is a **relative** `/mirror/…` path, not an absolute origin. The dashboard iframes page previews and the reader under whatever host serves it, and the page CSP is `frame-src 'self'`. A relative path keeps every framed request same-origin — so the same manifest works on `workers.dev`, a custom domain, or a future scoped `/<project>` route without CSP changes. `originalUrl` stays absolute (the external "Open ↗" link to tot.page).

## Commands

```bash
# Save the endpoint and sync token into Keychain without placing the token in shell history.
read -s TOT_DASHBOARD_SYNC_TOKEN
export TOT_DASHBOARD_SYNC_TOKEN
tot dashboard configure https://dashboard.example.com
unset TOT_DASHBOARD_SYNC_TOKEN

# Reconcile ~/.tot with R2 and publish the manifest last.
tot dashboard sync

# Download a restorable content-addressed copy. Existing objects are skipped.
tot dashboard backup /srv/backups/tot-dashboard

# Restore a verified archive into an empty/replacement R2-backed dashboard.
tot dashboard restore /srv/backups/tot-dashboard

# Local server at login plus quiet cloud reconciliation every five minutes.
tot dashboard install-agent
```

The macOS client reads the Access client ID and secret from the
`tot-dashboard-access` Keychain service using accounts
`<cloud-host>:client-id` and `<cloud-host>:client-secret`. On non-macOS backup
hosts, provide `TOT_DASHBOARD_SYNC_TOKEN`, `CF_ACCESS_CLIENT_ID`, and
`CF_ACCESS_CLIENT_SECRET` through the host's secret manager or a root-readable
environment file. Do not put them in a shell profile, command history,
repository, or plist.

## Cloudflare deployment

```bash
pnpm cloud:types
pnpm typecheck
pnpm wrangler deploy --dry-run
pnpm cloud:deploy
```

Wrangler configuration is in `wrangler.jsonc`. Required secret names are declared under `secrets.required`; values are managed with `wrangler secret put` and are not present in the file.

### Cloudflare Access

Protect the Worker before setting the Access variables:

1. Open **Workers & Pages → tot-dashboard → Settings → Domains & Routes**.
2. Enable Cloudflare Access for the `workers.dev` route, or attach a custom domain and create a self-hosted Access application for it.
3. Create an Allow policy for the approved teammate email addresses or company email domain. Access is deny-by-default.
4. Copy the team domain (`https://<team>.cloudflareaccess.com`) and application AUD tag.
5. Set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `wrangler.jsonc`, regenerate types, and deploy.

The hostname-wide application protects browser traffic with an email-scoped
**Allow** policy. Create a second, more-specific self-hosted Access application
for `tot-dashboard.scott-c93.workers.dev/api/sync/*` with a **Service Auth**
policy that includes only the named `Tot Dashboard Sync` service token.
Cloudflare gives the more-specific application path precedence over the
hostname-wide application. Sync and backup requests must send that token using
`CF-Access-Client-Id` and `CF-Access-Client-Secret`; the Worker then separately
requires its 256-bit `SYNC_SECRET` bearer token.

The Worker independently validates the `Cf-Access-Jwt-Assertion` signature, issuer, and audience. Do not replace this with trust in an unverified email header.

## Sync behavior

Sync performs four bounded steps:

1. Read the previous cloud manifest.
2. Fetch each living Tot and every asset recorded in its local registry entry.
3. Rewrite known absolute Tot asset URLs to paths inside the mirror, hash the mirrored document, and upload missing objects only.
4. Publish a sanitized manifest only after all content succeeds.

Unchanged Tots retain their original `syncedAt` value. If the complete catalog is unchanged, the current manifest and snapshot history are not written again.

The public manifest includes display names, original URLs, mirror URLs, content hashes, sizes, timestamps, and asset paths. It excludes local directory paths, API keys, Workspace IDs, and document IDs.

Rename and visibility controls are intentionally localhost-only. A custom display name is stored as dashboard metadata in `~/.tot`; it does not rename the source file or alter the published document. Hiding a Tot also changes only local metadata: the original `tot.page` remains alive and the entry can be restored through **Show hidden**. The next scheduled reconciliation omits hidden entries and publishes custom display names to the Cloudflare manifest. Permanent deletion uses the existing Workspaces deletion API and removes the local registry entry.

## Hostinger backup

The production VPS units live in [`deploy/hostinger`](../deploy/hostinger/README.md).
They run `tot dashboard backup` hourly as an unprivileged `totbackup` user and
write only to `/srv/backups/tot-dashboard`. Both authentication layers are
supplied through a root-only environment file rather than being embedded in a
unit or command.

The official Hostinger CLI is named `hapi`, but routine archive replication only requires SSH access to the VPS. Once SSH keys are configured:

1. Install Node.js and `@plannotator/tot` on the VPS.
2. Store `TOT_DASHBOARD_SYNC_TOKEN`, `CF_ACCESS_CLIENT_ID`, and `CF_ACCESS_CLIENT_SECRET` in a root-readable environment file or systemd credential.
3. Run `tot dashboard backup /srv/backups/tot-dashboard` from a systemd timer or cron job.
4. Back up `/srv/backups/tot-dashboard` with the VPS provider snapshot system as an additional layer.

The backup command downloads `manifest/current.json`, dated manifest snapshots,
and every document/asset referenced by the current catalog. It verifies each
existing and downloaded object against the manifest digest. Asset hashes are
part of the Tot version, so an asset-only change creates a new immutable object
tree and is downloaded on the next run.

## Restore runbook

1. Deploy the same Worker configuration against an empty replacement R2 bucket.
2. Configure `SYNC_SECRET`, the path-scoped Access Service Auth application,
   and the local/VPS service-token credentials as described above.
3. Validate the archive before changing DNS or routes:

    ```bash
    tot dashboard restore /srv/backups/tot-dashboard --cloud https://replacement.example.com
    ```

    Restore verifies every local object digest, uploads all objects first, and
    publishes a new current manifest last. It refuses missing, oversized,
    malformed, or corrupted archive content.

4. Open `/api/tots` through an authenticated browser and confirm its count
   matches `manifest/current.json`, then render several HTML Tots with their
   assets before moving the production route.
5. Keep the original archive untouched. The command restores the latest
   operational catalog; historical manifest snapshots remain available under
   `manifest/snapshots/` for audit or a targeted older recovery.

An archive is valid when:

- `manifest/current.json` parses and its `count` matches the `tots` array;
- every manifest document exists under `tots/<slug>/<contentHash>/<docPath>`;
- every listed asset exists beside the document at its recorded workspace path;
- every document and asset digest matches the manifest;
- a sample HTML document renders with networking disabled.
