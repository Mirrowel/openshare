# Branding example — the Mirrobot deployment skin

This folder is a complete, working example of branding an OpenShare
deployment. Nothing here is applied by default — the tracked
`share-worker/openshare.config.json` ships empty (the neutral upstream
look). Use this as the template when you want your own skin.

## What's in the box

- `openshare.config.json` — the branding config with every field set the
  way the Mirrobot deployment runs it (plus a field-by-field `$comment`)
- `mirrobot.png` — the logo asset (15 KB PNG)

## Applying a skin (3 steps)

1. **Ship the asset**: copy your logo into
   `share-viewer/public/branding/`. Vite copies `public/` into the
   viewer build, so the file serves at `/branding/<file>`.
2. **Set the config**: copy this `openshare.config.json` to
   `share-worker/openshare.config.json` and edit the values.
3. **Build + deploy**:
   ```
   cd share-viewer && npm run build
   cd ../share-worker && npx wrangler deploy
   ```

## Fields

| field | where it shows |
|---|---|
| `name` | header tooltip, footer text, login card, gone page, `og:title` |
| `logoUrl` | left-header chip (linked when `linkUrl` is set), login card, gone page, `og:image` fallback |
| `wordmarkUrl` | footer image (empty = `name · Open(code)Share` text) |
| `linkUrl` | where the header logo chip points |
| `accent` | hex color: status dot, login card, prompt-rail marker, agent-switch name |
| `faviconUrl` | the tab favicon |
| `backgroundUrl` | page background (rendered with a readability overlay; users can toggle it off in settings) |
| `description` | login-card subtitle and `og:description` |
| `ogTitle` | full custom embed/link-preview title (empty = `name · Open(code)Share`) |
| `ogImage` | link-preview image for chats/social; falls back to `logoUrl` |

All fields optional; empty string = hide / fall back.

## Priority

`BRAND_*` env vars (or `[vars]` in `wrangler.toml`) override the config
file field-by-field — file > code defaults. The env names are the
uppercased field with underscores: `BRAND_NAME`, `BRAND_LOGO_URL`,
`BRAND_OG_IMAGE`, ...

## Link previews (og: tags)

Crawler user-agents (Discordbot, TelegramBot, Slackbot, WhatsApp,
Twitterbot, ...) never run the SPA, so the worker serves them
`index.html` with `og:`/`twitter:` tags injected from the branding:
`og:title` = `ogTitle` (or `name · Open(code)Share`), `og:description`
= `description`, `og:image` = `ogImage` (absolute URL). The title never
carries a session title — a link preview must not leak what a share
contains. Browsers get the plain SPA (the viewer also injects the same
tags client-side as a fallback).

The portable Bun server supports the same fields via `BRAND_*` env vars
and the same crawler rewrite.

## Verifying

```
curl https://<your-worker>/branding          # the resolved JSON
curl -A "Discordbot" https://<your-worker>/  # og tags in the HTML head
```
