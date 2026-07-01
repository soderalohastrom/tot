# Handoff

Notes for whichever LLM picks this repo up next. Written 2026-07-01 after a session
that added Open Graph / Twitter Card support to the `tot` CLI.

## What changed this session

**Goal:** pages published with `tot` were invisible to Slack/Notion/Discord/iMessage
link-unfurlers — no `<title>`, no OG tags, so shared links rendered as bare text.

1. **`src/og.ts`** — `injectOpenGraph(html, meta)`. Injects `<title>` + description +
   Open Graph + Twitter Card `<meta>` tags right after `<head>` (not before `</head>`,
   so they win over any pre-existing tags in the source file — crawlers use the first
   match). Escapes all values.

2. **`src/banner.ts`** — `renderBannerPng(meta)`. When `--title` is passed without
   `--image`, the CLI auto-generates a colored 1200×630 title/description card and
   publishes it as the `og:image`/`twitter:image`, so every page gets a real thumbnail
   with zero extra steps. Rendered via `@resvg/resvg-js` (Rust/napi-rs, prebuilt
   binaries) rather than shelling out to `rsvg-convert`/ImageMagick, since this is a
   published npm package — it can't assume a system binary exists on someone else's
   machine. Color is chosen deterministically by hashing the title across 6 warm
   palettes (teal/amber/forest/brick/indigo/plum), so re-publishing the same page
   keeps the same color. Text is real word-wrapped (2 lines max, conservative
   char-width budget) — an earlier char-count-truncation approach let long
   descriptions run off the canvas edge; fixed and covered by a regression test.

3. **`src/commands.ts`** — `publishCommand`/`updateCommand` wire the above in.
   New `PublishOpts.og` (title/description/image/url) and `PublishOpts.noAutoImage`.
   Key wrinkle: a **fresh** `tot <file>` publish doesn't have a slug yet, but
   `og:image` needs an absolute URL baked into the HTML *before* upload — so when
   auto-image applies, the workspace is created early (extra `POST /v1/workspaces`)
   just to learn the slug, then reused for the asset+document upload instead of
   creating it twice. `tot update` has no such problem — the slug is already known
   from the registry, so auto-image resolves inline. The auto-generated asset is
   named `__tot-og-image.png` (double-underscore namespaced) to avoid colliding with
   a real content image of the same name.

4. **`src/cli.ts`** — new flags: `--title`, `--description`, `--image`, `--url`,
   `--no-image`. `--title` is required to use any of the others. Markdown files
   error clearly if OG flags are passed (`.md` has no `<head>`).

5. **Global install swapped** — the `tot` binary on this machine's PATH
   (`/opt/homebrew/bin/tot`) was the published `@plannotator/tot` npm package;
   it's now `npm link`'d to this working copy, so `pnpm build` here immediately
   affects the live `tot` command. No re-link needed after future edits — just rebuild.

6. **Toolchain pins fixed** (unrelated to the OG feature, but was blocking a clean
   `pnpm build`): this repo's `packageManager` bumped `pnpm@10.18.0` → `pnpm@11.9.0`.
   The `pnpm` binary that was actually resolving on this machine's PATH was a stale
   `pnpm@9.0.4` installed as a plain dependency in `~/package.json` (not a corepack
   shim) — it was swapped in place to `11.9.0` too. `pnpm-workspace.yaml` in this repo
   is new: pnpm 11 blocks postinstall scripts by default now, and `esbuild` (a
   `vitest` transitive dep) needed one approved (`pnpm approve-builds --all`
   wrote this file).

7. **Companion skill updated** — `~/.claude/skills/tot-publish/SKILL.md` (v1.1.1 →
   v1.2.0), *not* part of this repo. Documents the new flags, corrects an outdated
   claim that `tot` "cannot fetch assets" / has no image support (it does — local
   images/CSS/JS upload automatically, which is exactly what the auto-banner uses),
   fixes an inaccurate `tot update <file> <url>` two-arg example (the CLI only ever
   reads one positional), and adds a "vary the accent color, at will" note so
   agent-generated pages don't all default to the same teal-on-paper look.

## Verified against the live API

Published and inspected several real test pages during this session (dogs, cats,
birds) at `tot.page/...` — confirmed `og:image`/`twitter:image` resolve to live
200-OK PNGs, `<head>` tags are correct, and the word-wrap fix actually renders
without clipping. No stub-only testing — this went through the real
`workspaces.plannotator.ai` API.

## Test coverage added

`test/og.test.ts`, `test/banner.test.ts`, integration cases in
`test/commands.test.ts` (auto-image on publish/update, explicit `--image` skips
generation, `--no-image` suppresses it, unchanged title/description skips
re-uploading the deterministic banner). 58/58 tests passing as of this commit.
`pnpm typecheck` shows one **pre-existing, unrelated** error in `src/http.ts`
(a `@types/node`/`fetch` overload mismatch) — confirmed via `git stash` that it
predates this session; not touched.

## Known simplifications / follow-ups (not blockers)

- Banner text wrapping uses a conservative estimated average character width,
  not real glyph metrics — safe (errs toward wrapping early) but not pixel-perfect.
- No markdown→HTML conversion mode — `--title`/etc. only work on `.html` files.
  Raw `.md` publishing is unaffected and still works as before.
- `og:url` on a **fresh** publish is only set if you pass `--url` manually (the
  slug doesn't exist yet at HTML-generation time). On `tot update` it auto-fills
  from the page's already-known living URL.
- The auto-banner asset path (`__tot-og-image.png`) is a fixed name, not
  content-addressed — fine in practice (one banner per page), just noting it's
  a convention rather than a guarantee against a determined name collision.

## To resume verifying

```bash
cd /Users/soderstrom/PROJECTS/tot
pnpm install && pnpm build && pnpm test   # 58/58, no COREPACK_ENABLE_STRICT needed
tot /tmp/whatever.html --title "Test" --description "..."   # auto-banner, live publish
```
