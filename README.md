<p align="center">
  <img src="https://tot.page/tot.webp" alt="tot" width="700">
</p>


# tot.page

Publish a page in one command. Any markdown or HTML file → a live link on <strong>tot.page</strong>. No signup.

```bash
npm i -g @plannotator/tot
```
Usage:
```
tot notes.md
→ https://tot.page/aB3xK9qLm2_QsBOlkxoSt
```

## Commands

| Command | What it does |
|---|---|
| `tot notes.md` | Publish markdown — rendered to a page. |
| `tot page.html` | Publish HTML — served exactly as written. |
| `tot update <link>` | Push new content — the same link updates. |
| `tot list` | See everything you've published. |
| `tot remove <link>` | Take a page back down. |
| `tot login --key <key>` | Optional: publish as an owned account (else anonymous). |

## How it works

- **Markdown renders, HTML is served as-is.** Whatever you publish, that's what people see.
- **Links are live.** Re-publish and the same `tot.page/...` link shows the latest — or use the frozen `@version` snapshot URL for a permanent capture that never changes.
- **No accounts, no tokens.** The link is the key: anyone you give it to can view it.

> **Be intentional with the link.** A page you publish is *open* — anyone who has the link can also **edit or delete** it. There's no private mode and nothing to log into. Share the link with that in mind.

## Configuration

State lives in `~/.tot` (the API endpoint and your list of published pages). Override the API origin per-run with `--endpoint <url>`.

## Built on

[Cloudflare Artifacts](https://www.cloudflare.com/products/artifacts/)

## License

MIT
