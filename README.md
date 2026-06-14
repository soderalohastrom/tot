<p align="center">
  <img src="https://tot.page/tot.webp" alt="tot" width="700">
</p>


# tot.page

Publish a markdown or HTML file to a live link in one command. No signup.

```bash
npm i -g @plannotator/tot
```

```
tot notes.md
→ https://tot.page/aB3xK9qLm2_QsBOlkxoSt
```

## Commands

| Command | What it does |
|---|---|
| `tot notes.md` | Publish markdown. It renders to a page. |
| `tot page.html` | Publish HTML. It is served exactly as written. |
| `tot update <link>` | Push new content. The same link updates. |
| `tot list` | Show what you have published. |
| `tot remove <link>` | Take a page down. |
| `tot login --key <key>` | Optional. Publish as an owned account instead of anonymous. |

## How it works

Markdown renders to a page. HTML is served byte for byte.

Your link is live. Run `tot update` and the same `tot.page/...` link shows the new version. Every version also keeps a frozen `@hash` link that never changes, for when you want a fixed snapshot.

No accounts, no tokens. The link is the key.

> A page you publish is open. Anyone who has the link can view it, update it, or delete it. There is no private mode. Share the link with that in mind.

## Configuration

State lives in `~/.tot`: the API endpoint and the list of pages you have published. Override the API origin for one run with `--endpoint <url>`.

## Built on

[Cloudflare Artifacts](https://www.cloudflare.com/products/artifacts/). Every version is a real git commit.

## License

MIT
