# Pre-Market Analyzer — Deployment

Static single-page app (`index.html` + `manifest.json` + `assets/`) hosted on **Cloudflare Pages**, with a separate **Cloudflare Worker** as the live-data proxy (`cloudflare-worker/`).

## Deploy the static site (Cloudflare Pages)

```bash
# 1. One-time setup
npm i -g wrangler        # or use npx
wrangler login
wrangler pages project create premarket-analyzer --production-branch main

# 2. Deploy
./deploy.sh              # builds public/ and uploads it
```

The site goes live at `https://premarket-analyzer.pages.dev`.

## Point the app at the live-data worker

In `index.html`, set `dataProxy` (in the `CONFIG` block) to your deployed worker URL:

```js
dataProxy: 'https://premarket-live.<your-name>.workers.dev',
```

The worker itself is deployed separately (see `cloudflare-worker/worker.js`).

## Custom domain (free)

1. Get a free domain at `eu.org` or `us.kg` (or buy any `.com`).
2. In Cloudflare dashboard: **Workers & Pages → your project → Custom domains → Add**.
3. Follow the DNS instructions (nameservers/records). Cloudflare DNS is free.

Example: `https://premarket-analyzer.eu.org`.

## Pushing to GitHub (optional, enables auto-deploys)

```bash
git add -A && git commit -m "Deploy pre-market analyzer to Pages"
git remote add origin https://github.com/<you>/premarket-analyzer.git
git push -u origin main
```

Then in the dashboard: **Workers & Pages → Create → Pages → Connect to Git** and pick this repo. Every `git push` redeploys automatically.
