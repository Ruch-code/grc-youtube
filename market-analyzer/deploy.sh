#!/usr/bin/env bash
# Deploys the Pre-Market Analyzer static site to Cloudflare Pages.
#
# First time only:
#   1. Install Wrangler:   npm i -g wrangler   (or: npx wrangler)
#   2. Log in:             wrangler login
#   3. Create the project: npx wrangler pages project create premarket-analyzer --production-branch main
#      (or use the Pages dashboard: Create project -> Upload assets)
#   4. Optionally set the custom domain later:
#      npx wrangler pages project ...  (or do it in the dashboard: project -> Custom domains)
#
# Then run:  ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

./build.sh

echo "→ Deploying to Cloudflare Pages …"
npx wrangler pages deploy public --project-name premarket-analyzer --branch main

echo "✓ Deployed! Your site is live at:"
echo "    https://premarket-analyzer.pages.dev"
