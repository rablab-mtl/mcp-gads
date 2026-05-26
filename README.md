# mcp-gads

A remote Model Context Protocol (MCP) server, deployed on Cloudflare Workers, that exposes **read-only Google Ads data** to MCP clients such as Claude Desktop, Cowork, Lovable Agent, and the MCP Inspector.

Built for the Rablab agency to power campaign reporting and paid-media diagnostics workflows. Open for forks.

## Features

- **14 read-only Google Ads tools**, all backed by GAQL on the official Google Ads REST API
- OAuth 2.0 user authentication via Google with the `adwords` scope, no service accounts
- Automatic refresh token, no need to reconnect every hour
- Works with Dynamic Client Registration (DCR) for compatibility with MCP Inspector, Cowork, Claude Desktop, Lovable, etc.
- Email and domain allowlist via `ALLOWED_EMAILS` and `ALLOWED_DOMAINS` secrets, so only authorized accounts can mint an MCP token
- Branded "Acces refuse" page for users outside the allowlist (Rablab colors)
- Multi-user friendly, each authorized user authenticates with their own Google account and only sees the Google Ads accounts that account already has access to
- Deployed once on Cloudflare Workers, available to a whole team
- Defensive read-only enforcement: any GAQL query that includes mutate, insert, update, delete, create, drop, or remove is rejected before it reaches the API

## Available tools

All tools are read-only. No mutation endpoint is exposed.

| Tool | Purpose |
| --- | --- |
| `gads_list_accessible_customers` | List customer IDs directly accessible to the authenticated user |
| `gads_get_customer` | Descriptive name, currency, timezone, manager flag, test flag for one customer |
| `gads_search` | Run an arbitrary read-only GAQL query, with pagination |
| `gads_search_stream` | Run a GAQL query and stream all rows in one call (no pagination) |
| `gads_list_campaigns` | List campaigns with id, name, status, channel, budget |
| `gads_get_campaign_performance` | Per-campaign KPIs over a date range (impressions, clicks, cost, conv, ROAS, CPA) |
| `gads_list_ad_groups` | List ad groups, optionally filtered by campaign and status |
| `gads_get_keyword_performance` | Per-keyword KPIs with match type and quality score |
| `gads_get_search_terms_report` | Search terms that triggered ads, with KPIs (negative keyword candidates) |
| `gads_get_ad_performance` | Per-ad KPIs with final URLs |
| `gads_list_conversion_actions` | All conversion actions configured on the account |
| `gads_get_change_event_history` | Audit log of changes on the account (last 30 days, Google Ads limit) |
| `gads_get_account_summary` | Account-level KPIs over a date range |
| `gads_list_fields` | Discover GAQL fields available for queries (metadata helper) |

## Architecture

```
MCP client (Claude, Cowork, Lovable, Inspector)
        |
        | MCP over SSE
        v
Cloudflare Worker (this repo)
        |
        +-- @cloudflare/workers-oauth-provider
        |     handles MCP OAuth + Dynamic Client Registration
        +-- google-handler.ts
        |     handles Google OAuth flow + email allowlist + refresh token
        +-- 13 MCP tools backed by Google Ads REST API v20
                |
                v
        Google Ads API (googleads.googleapis.com)
```

## Setup for your own deployment

If you fork this repo to deploy your own MCP server.

### 1. Google Cloud setup

In your Google Cloud project:

1. **Enable the Google Ads API.**
2. **Configure the OAuth Consent Screen** (Audience: External, mode Test, add yourself as a test user).
3. **Create an OAuth 2.0 Client ID**, type Web Application:
   - Authorized JavaScript origin: `https://<your-worker-name>.<your-subdomain>.workers.dev`
   - Authorized redirect URI: `https://<your-worker-name>.<your-subdomain>.workers.dev/callback`
4. Note the **Client ID**. Click `Add secret`, copy the **Client Secret** value (shown only once).

### 2. Google Ads Developer Token

The Google Ads API requires a **Developer Token** attached to a Manager (MCC) account. The token is a separate credential from the OAuth Client.

1. Sign into the MCC that will issue the token.
2. Go to `Tools and settings -> API Center` (only visible on a manager account).
3. Apply for a Developer Token. New tokens start at Test level (test accounts only). Apply for Basic Access (15 000 ops/day) for production accounts. Approval is usually 1 to 5 business days.
4. Copy the token, it will be set as a Cloudflare secret.

### 3. Cloudflare setup

1. Create a KV namespace, name it `OAUTH_KV`. Note its ID.
   ```bash
   npx wrangler kv namespace create OAUTH_KV
   ```
2. Edit `wrangler.jsonc`:
   - `name`: your worker name (this controls the URL)
   - `kv_namespaces[0].id`: replace with your KV namespace ID
   - `vars.GADS_LOGIN_CUSTOMER_ID`: (optional) your MCC id as a plain string, 10 digits no dashes, used when accessing customers under a manager. Can also be passed per call.

### 4. Deploy

```bash
npm install --legacy-peer-deps

npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY # any random 32-char hex string, e.g. openssl rand -hex 32
npx wrangler secret put HOSTED_DOMAIN          # press Enter for empty (accept any Google account)
npx wrangler secret put ALLOWED_EMAILS         # comma-separated emails
npx wrangler secret put ALLOWED_DOMAINS        # optional, comma-separated domains
npx wrangler secret put GADS_DEVELOPER_TOKEN   # Google Ads Developer Token from MCC -> API Center

npx wrangler deploy
```

At least one of `ALLOWED_EMAILS` or `ALLOWED_DOMAINS` must be set, otherwise no one can sign in (see Access control below).

### 5. Access control: `ALLOWED_EMAILS` and `ALLOWED_DOMAINS`

After a user signs in with Google, the worker checks their email against two Cloudflare secrets before issuing an MCP token:

- `ALLOWED_EMAILS`: comma-separated list of full email addresses allowed to authenticate (case-insensitive). Example: `alice@example.com,bob@example.com`.
- `ALLOWED_DOMAINS`: comma-separated list of domains. Any email ending with `@domain` is allowed (case-insensitive). Example: `example.com,partner.com`.

The two lists are additive: an email is allowed if it matches either one.

If neither secret is set, the worker rejects every sign-in. This is intentional. Without an allowlist, any Google account could complete the OAuth flow and mint a token, burning the deployment.

Unauthorized users get a branded "Acces refuse" 403 page (Rablab colors) instead of a token. No error leaks to the MCP client.

To update the allowlist after deployment:

```bash
npx wrangler secret put ALLOWED_EMAILS
```

The change takes effect on the next sign-in. Existing MCP tokens stay valid until they expire; to revoke immediately, purge the `OAUTH_KV` namespace.

### 6. Test with MCP Inspector

```bash
npx @modelcontextprotocol/inspector@latest
```

Open `http://localhost:6274`. Set Transport Type to SSE, URL to `https://<your-worker>.workers.dev/sse`, click Connect. A Google OAuth flow opens, approve the scopes. Then try `gads_list_accessible_customers` to confirm it works.

If you sign in with an unlisted email, you should see the "Acces refuse" 403 page instead. Use this to validate the allowlist before sharing the worker URL with your team.

### 7. Connect to Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gads": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<your-worker>.workers.dev/sse"]
    }
  }
}
```

Restart Claude Desktop. The first time you call a tool, an OAuth flow opens in your browser.

### 8. Connect at organization level (recommended)

If you have an Anthropic organization (Claude Team or Enterprise), add the worker URL as a custom connector at the organization level. Every team member gets access in Cowork, Claude Desktop, and claude.ai web without local config. The allowlist enforces who can actually authenticate.

## Local development

```bash
npm install --legacy-peer-deps
cp .dev.vars.example .dev.vars
# Fill in the values in .dev.vars (do not commit this file)
npx wrangler dev
```

For local dev, set `ALLOWED_EMAILS` (and optionally `ALLOWED_DOMAINS`) and `GADS_DEVELOPER_TOKEN` in `.dev.vars` too, otherwise the local worker rejects all sign-ins or fails on API calls.

## CI/CD with Cloudflare Workers Builds

This repo is set up to auto-deploy on push to `main` via Cloudflare Workers Builds. Connect this GitHub repository in your Cloudflare Workers dashboard:

- Build command: `npm install --legacy-peer-deps`
- Deploy command: `npx wrangler deploy`
- Production branch: `main`

Each commit on `main` rebuilds and redeploys the worker. Other branches build preview workers at distinct URLs.

Secrets (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY`, `HOSTED_DOMAIN`, `ALLOWED_EMAILS`, `ALLOWED_DOMAINS`, `GADS_DEVELOPER_TOKEN`) are set once with `wrangler secret put` and persist across deploys.

## Security notes

- **All Google Ads API calls are read-only.** No write scope is requested (only `adwords` exists as a Google Ads scope, but the worker never exposes a `:mutate` endpoint and rejects any GAQL query containing mutate/insert/update/delete/create/drop/remove).
- Tokens (access and refresh) are stored encrypted in the OAuth provider's KV store and as Durable Object props, never logged.
- The `.dev.vars` file (containing local secrets for development) is gitignored.
- Access is restricted by the `ALLOWED_EMAILS` and `ALLOWED_DOMAINS` allowlist, checked server-side after Google OAuth. Without at least one of these secrets set, the worker rejects all sign-ins by design.
- Each authorized user authenticates with their own Google account, so the worker only has access to the Google Ads accounts that user already has access to. No service account, no shared credentials.
- The Developer Token is the most sensitive secret. Revoke and rotate it via the MCC API Center if exposed.
- Set the OAuth Consent Screen to Test mode and only add trusted test users until you complete Google verification (only required for more than 100 users).

## Credits

This project follows the same architecture as Rablab's `mcp-ga4-gsc` worker (forked from `bighadj22/cloudflare-mcp-google-oauth-analytics`). It reuses:

- `@cloudflare/workers-oauth-provider` for MCP OAuth + Dynamic Client Registration
- `agents/mcp` Durable Object pattern for stateful MCP sessions
- Google OAuth flow with `access_type=offline` for automatic refresh tokens
- The email/domain allowlist gate and branded denied page (Rablab colors)

The Google Ads tool surface is inspired by the official `googleads/google-ads-mcp` (Python/FastMCP) reference, but reimplemented in TypeScript for Cloudflare Workers and locked to read-only.

## License

MIT, see LICENSE.
