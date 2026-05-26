/**
 * Build the Google OAuth authorize URL.
 * `access_type=offline` + `prompt=consent` are required to obtain a refresh_token
 * (Google only returns refresh_token on first consent unless prompt=consent forces it).
 */
export function getUpstreamAuthorizeUrl({
  upstreamUrl,
  clientId,
  scope,
  redirectUri,
  state,
  hostedDomain,
}: {
  upstreamUrl: string
  clientId: string
  scope: string
  redirectUri: string
  state?: string
  hostedDomain?: string
}) {
  const upstream = new URL(upstreamUrl)
  upstream.searchParams.set('client_id', clientId)
  upstream.searchParams.set('redirect_uri', redirectUri)
  upstream.searchParams.set('scope', scope)
  upstream.searchParams.set('response_type', 'code')
  upstream.searchParams.set('access_type', 'offline')
  upstream.searchParams.set('prompt', 'consent')
  if (state) upstream.searchParams.set('state', state)
  if (hostedDomain && hostedDomain.length > 0) upstream.searchParams.set('hd', hostedDomain)
  return upstream.href
}

export interface GoogleTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
  scope?: string
  id_token?: string
}

/**
 * Exchange an authorization code for tokens.
 * Returns the full token response including refresh_token and expires_in.
 * Uses snake_case body params as required by Google OAuth 2.0.
 */
export async function fetchUpstreamAuthToken({
  clientId,
  clientSecret,
  code,
  redirectUri,
  upstreamUrl,
  grantType,
}: {
  code: string | undefined
  upstreamUrl: string
  clientSecret: string
  redirectUri: string
  clientId: string
  grantType: string
}): Promise<[GoogleTokenResponse, null] | [null, Response]> {
  if (!code) {
    return [null, new Response('Missing code', { status: 400 })]
  }

  const resp = await fetch(upstreamUrl, {
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: grantType,
      redirect_uri: redirectUri,
    }).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    method: 'POST',
  })
  if (!resp.ok) {
    const errText = await resp.text()
    console.log('Google token exchange error:', errText)
    return [null, new Response(`Failed to fetch access token: ${errText}`, { status: 500 })]
  }

  const body = (await resp.json()) as GoogleTokenResponse
  if (!body.access_token) {
    return [null, new Response('Missing access token', { status: 400 })]
  }
  return [body, null]
}

/**
 * Refresh an expired access token using the long-lived refresh_token.
 * Returns { access_token, expires_in } (Google does not return a new refresh_token).
 */
export async function refreshAccessToken({
  clientId,
  clientSecret,
  refreshToken,
}: {
  clientId: string
  clientSecret: string
  refreshToken: string
}): Promise<{ access_token: string; expires_in: number } | null> {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString(),
  })
  if (!resp.ok) {
    console.log('Refresh token error:', await resp.text())
    return null
  }
  const body = (await resp.json()) as { access_token: string; expires_in: number }
  if (!body.access_token) return null
  return body
}

// Context from the auth process, encrypted & stored in the OAuth token
export type Props = {
  name: string
  email: string
  accessToken: string
  refreshToken: string
  tokenExpiresAt: number // epoch ms
}

/**
 * Normalize a Google Ads customer ID to the canonical numeric form.
 * Accepts inputs like "123-456-7890", "customers/1234567890", or "1234567890"
 * and returns "1234567890".
 */
export function normalizeCustomerId(input: string): string {
  if (!input) throw new Error('Missing customer_id')
  const s = String(input).trim()
  const stripped = s.replace(/^customers\//i, '').replace(/-/g, '').trim()
  if (!/^\d+$/.test(stripped)) {
    throw new Error(`Invalid customer_id: "${input}". Expected a 10-digit numeric ID, with or without dashes.`)
  }
  return stripped
}
