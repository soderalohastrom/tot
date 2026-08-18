<p align="center">
  <img src="./site/assets/readme/totpage2.webp" alt="tot.page" width="700">
  <br>
  <sub><a href="https://tot.page">tot.page</a> is what enables <a href="https://palapala.me">palapala.me</a></sub>
</p>

# pala — write it, keep it.

Publish a markdown or HTML file to a live link in one command. No signup.

The useful part is that it is **git-backed publishing**, not a one-off upload. The link you share is
living, like a branch: run `pala update` and the same URL moves forward. Every publish also creates a
real version with a frozen `@hash` URL, like a commit, so you can point people at either "latest" or
"exactly this snapshot."

```bash
npm i -g @plannotator/tot   # installs a binary called `pala`
```

```
pala notes.md
  ↳ https://tot.page/aB3xK9q
  commit  e5f6c1a
  frozen  https://tot.page/aB3xK9q/index.md@e5f6c1a
```

> The binary is `pala`. The legacy `tot` command is kept as an alias for one minor so
> existing scripts keep working — both names invoke the same code.

## Commands

| Command                  | What it does                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `pala notes.md`          | Publish markdown as the raw `.md` file.                                                |
| `pala page.html`         | Publish HTML as the raw `.html` file, plus local support files it directly references. |
| `pala update <link>`     | Push new content. The same link updates.                                               |
| `pala list`              | Show what you have published.                                                          |
| `pala dashboard`         | Browse and search your published pages in a local visual dashboard.                    |
| `pala remove <link>`     | Remove the living page from its share link.                                            |
| `pala login --key <key>` | Optional. Publish as an owned account instead of anonymous.                            |

## How it works

Files are served byte for byte. Markdown comes back as raw markdown. HTML comes back as raw HTML.

For HTML, `pala` also uploads direct local browser dependencies before the page goes live: images,
stylesheets, scripts, video, `srcset` entries, and video posters. It skips external URLs and ordinary
navigation links. There is no config file, build step, routing layer, or bundler.

Your link is live. Run `pala update` and the same `tot.page/...` link shows the new version. Every version also keeps a frozen `@hash` link that never changes, for when you want a fixed snapshot.

`pala remove` removes the living page. Frozen snapshot links are permanent while the workspace exists.

No accounts, no tokens. The link is the key. Treat them as you would excalidraw.

> A page you publish is open. Anyone who has the link can view it, update it, or delete it. There is no private mode. Share the link with that in mind.

## Local dashboard

Run the dashboard from this repository or an installed package:

```bash
pala dashboard
```

It opens `http://127.0.0.1:4173` with card and list views, fuzzy search, live page previews, a resizable reading panel, automatic registry refresh, and light/dark themes. Drag the divider beside the reader to resize it; the browser remembers the width. In card view, hover or focus a Pala to rename it, hide it from both dashboards, or permanently delete the published page. Hidden Palas remain registered and published; use **Show hidden** to restore them. The browser receives a sanitized projection of `~/.tot`; API keys and workspace/document IDs are never included.

```bash
pala dashboard --port 4400 --no-open
pala dashboard --host 0.0.0.0 # explicit LAN binding
```

The default loopback binding is intentional. Dashboard mutations require an ephemeral token issued only to the local page and are rejected for non-loopback clients; management is disabled entirely when `--host` binds beyond loopback. The local dashboard is not a multi-user authenticated service and should not be exposed directly to the internet. The Cloudflare mirror reuses the interface with management controls disabled.

### Cloud mirror and backup

This fork includes a Cloudflare Worker + private R2 deployment that serves the same dashboard from a sanitized, content-addressed mirror — a searchable reading room for everything you publish, hosted on a domain you own and refreshed every five minutes.

```bash
pala dashboard configure https://your-dashboard.example.com
pala dashboard sync
pala dashboard backup /path/to/archive
pala dashboard restore /path/to/archive
```

The Worker sync credential and path-scoped Cloudflare Access service token are stored in macOS Keychain. They are never written to `~/.tot`, the dashboard manifest, or the repository. Repeated syncs deduplicate content and do not create new manifest snapshots unless something changes.

**Browser access is opt-in.** In-Worker Cloudflare Access verification turns on only when both `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set in `wrangler.jsonc`. Left unset, the dashboard is publicly readable — fine for a personal archive on your own domain; set both to require an Access sign-in. The `/api/sync/*` upload routes are always protected by the `SYNC_SECRET` bearer token regardless.

Manifest `url`s are same-origin relative `/mirror/…` paths, so the dashboard's page previews and reader work under any host or path prefix (`workers.dev`, a custom domain, or a scoped route) without CSP changes.

Install the local server and five-minute reconciliation as user LaunchAgents:

```bash
pala dashboard install-agent
pala dashboard uninstall-agent
```

See [docs/CLOUD_DASHBOARD.md](docs/CLOUD_DASHBOARD.md) for architecture, Cloudflare Access setup, restore behavior, and Hostinger backup instructions. Where this is headed next — owning the publisher end to end — is in [PALAPALA.md](PALAPALA.md), with the migration mechanics in [docs/PALAPALA_TAKEOVER.md](docs/PALAPALA_TAKEOVER.md).

## Configuration

State lives in `~/.tot`: the Workspaces API endpoint and the list of pages you have published. Override the API origin for one run with `--endpoint <url>`. Content links remain on `tot.page`; the API origin is `workspaces.plannotator.ai` for public release and `staging.workspaces.plannotator.ai` for staging verification.

> The `~/.tot` path is preserved through the rebrand. Migrating it to `~/.pala` would break
> external scripts that read from it, so it stays. A future minor may move it.

## Built on

[Cloudflare Artifacts](https://www.cloudflare.com/products/artifacts/). Every version is a real git commit.

## License

MIT