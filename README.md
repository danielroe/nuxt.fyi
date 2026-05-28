# nuxt.fyi

> Spots Nuxt sites being shared on Bluesky and posts screenshots of them.

[👉 &nbsp;Check it out](https://nuxt.fyi/)

The aim of [nuxt.fyi](https://nuxt.fyi/) is to celebrate sites built with [Nuxt](https://nuxt.com/) in the wild.

It watches the Bluesky [Jetstream](https://github.com/bluesky-social/jetstream) firehose, pulls every link out of every post, and for each new domain asks: *is this built with Nuxt?* When the answer is yes, it posts a screenshot on [Bluesky](https://bsky.app/profile/nuxt.fyi).

The [public dashboard](https://nuxt.fyi/) shows everything that's been detected, broken down by version and recency.

## Features

- Detection signals across HTML and a Playwright runtime probe (`<div id="__nuxt">`, `__NUXT_DATA__`, `window.__NUXT__`, `meta[name=generator]`, `/_nuxt/` assets)
- Screenshots taken in a persistent Chromium context, with layered cookie-banner suppression (GTM consent cookie, CSS overlay, and a pinned [`I-Still-Dont-Care-About-Cookies`](https://github.com/OhMyGuus/I-Still-Dont-Care-About-Cookies) extension)
- Discord + Bluesky notifications with rate-limit-aware posting
- Nuxt 4 dashboard reading the same SQLite database read-only
- Runs on a single [Fly.io](https://fly.io/) machine; daemon and dashboard share one volume
- Node 24+ only: native TS execution, `node:sqlite`, global `fetch` and `WebSocket`

## Try it out locally

You will need a [Discord webhook URL](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks) and, optionally, a Bluesky account with an [app password](https://bsky.app/settings/app-passwords) for posting.

```bash
cp .env.example .env
# edit .env, set DISCORD_WEBHOOK_URL (and BLUESKY_* if you want)

corepack enable
pnpm install
pnpm install-extension
pnpm exec playwright install chromium

# daemon
pnpm dev

# dashboard (separate terminal)
pnpm dev:dashboard
```

Set `VERBOSE=1` to log every post the daemon sees.

## Credits

Detection heuristics and the GTM consent-cookie trick are lifted from [`nuxtlabs/vue-telescope-analyzer`](https://github.com/nuxtlabs/vue-telescope-analyzer) ❤️

## License

Made with ❤️

Published under [MIT License](./LICENSE).
