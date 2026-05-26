#!/usr/bin/env bash
#
# One-shot deploy helper for mcp-gads.
# Run from the project root.
#
# Prompts for every secret if not already set. Skips deploy if secrets are missing.

set -euo pipefail

cd "$(dirname "$0")"

echo "==> Installing dependencies"
npm install --legacy-peer-deps

echo ""
echo "==> Setting Cloudflare secrets"
echo "    (Press Enter to skip a secret that is already set.)"
echo ""

for secret in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET COOKIE_ENCRYPTION_KEY HOSTED_DOMAIN ALLOWED_EMAILS ALLOWED_DOMAINS GADS_DEVELOPER_TOKEN; do
  read -rp "Set ${secret}? [y/N] " ans
  if [[ "${ans}" =~ ^[Yy]$ ]]; then
    npx wrangler secret put "${secret}"
  fi
done

echo ""
echo "==> Type-check"
npm run type-check

echo ""
echo "==> Deploy to Cloudflare"
npx wrangler deploy

echo ""
echo "Deploy complete. Test with: npx @modelcontextprotocol/inspector@latest"
