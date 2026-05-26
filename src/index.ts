import OAuthProvider from '@cloudflare/workers-oauth-provider'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { McpAgent } from 'agents/mcp'
import { z } from 'zod'
import { GoogleHandler } from './google-handler'
import { normalizeCustomerId, refreshAccessToken, type Props } from './utils'

function asTextResult(payload: unknown) {
  return {
    content: [{ text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2), type: 'text' as const }],
  }
}

/**
 * Defensive check: reject any GAQL query that looks like a mutation.
 * GAQL is read-only by spec (only SELECT statements), but we belt-and-suspenders
 * to make the read-only intent explicit in the code path.
 */
function assertReadOnlyQuery(query: string): void {
  const q = query.toLowerCase()
  const banned = ['mutate', 'insert', 'update ', 'delete ', 'create ', 'drop ', 'remove ']
  for (const kw of banned) {
    if (q.includes(kw)) {
      throw new Error(`Refused: GAQL query contains forbidden keyword "${kw.trim()}". mcp-gads is read-only.`)
    }
  }
  if (!q.trim().startsWith('select')) {
    throw new Error('Refused: GAQL query must start with SELECT. mcp-gads is read-only.')
  }
}

export class MyMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({
    name: 'Rablab Google Ads MCP',
    version: '0.1.0',
  })

  // In-memory cache of the refreshed token for this DO instance.
  private cachedAccessToken: string | null = null
  private cachedExpiresAt = 0

  /** Return a valid Google access_token, refreshing it transparently if expired. */
  private async getValidAccessToken(forceRefresh = false): Promise<string> {
    const props = this.props as Props
    const now = Date.now()
    if (!forceRefresh) {
      if (this.cachedAccessToken && this.cachedExpiresAt > now) {
        return this.cachedAccessToken
      }
      if (props.accessToken && props.tokenExpiresAt > now) {
        this.cachedAccessToken = props.accessToken
        this.cachedExpiresAt = props.tokenExpiresAt
        return props.accessToken
      }
    }
    if (!props.refreshToken) {
      throw new Error('Access token expired and no refresh_token available. Please reconnect this MCP.')
    }
    const refreshed = await refreshAccessToken({
      clientId: this.env.GOOGLE_CLIENT_ID,
      clientSecret: this.env.GOOGLE_CLIENT_SECRET,
      refreshToken: props.refreshToken,
    })
    if (!refreshed) {
      throw new Error('Failed to refresh Google access token. Please reconnect this MCP.')
    }
    this.cachedAccessToken = refreshed.access_token
    this.cachedExpiresAt = now + (refreshed.expires_in - 60) * 1000
    return refreshed.access_token
  }

  private apiBase(): string {
    const v = (this.env.GADS_API_VERSION || 'v20').replace(/^v?/, 'v')
    return `https://googleads.googleapis.com/${v}`
  }

  /**
   * Build the headers required by the Google Ads REST API.
   * - Authorization: Bearer <user access token>
   * - developer-token: required, identifies the developer (Rablab)
   * - login-customer-id: required when the user accesses customers via a manager (MCC).
   *   We accept an explicit override per call, otherwise fall back to env GADS_LOGIN_CUSTOMER_ID.
   */
  private gadsHeaders(token: string, loginCustomerOverride?: string): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'developer-token': this.env.GADS_DEVELOPER_TOKEN,
      'Content-Type': 'application/json',
    }
    const lc = (loginCustomerOverride ?? this.env.GADS_LOGIN_CUSTOMER_ID ?? '').trim()
    if (lc) {
      try {
        headers['login-customer-id'] = normalizeCustomerId(lc)
      } catch {
        /* ignore invalid override, do not break the call */
      }
    }
    return headers
  }

  /** Authed Google Ads API fetch, transparently refreshing the token on 401. */
  private async callGads(
    path: string,
    init: RequestInit & { loginCustomerId?: string } = {},
  ): Promise<unknown> {
    if (!this.env.GADS_DEVELOPER_TOKEN) {
      throw new Error('Missing GADS_DEVELOPER_TOKEN secret. Set it with: npx wrangler secret put GADS_DEVELOPER_TOKEN')
    }
    const url = path.startsWith('http') ? path : `${this.apiBase()}${path}`
    const { loginCustomerId, ...restInit } = init

    const doFetch = async (token: string) => {
      const resp = await fetch(url, {
        ...restInit,
        headers: {
          ...this.gadsHeaders(token, loginCustomerId),
          ...((restInit.headers as Record<string, string>) || {}),
        },
      })
      const text = await resp.text()
      let data: unknown
      try {
        data = JSON.parse(text)
      } catch {
        data = text
      }
      return { resp, data }
    }

    let token = await this.getValidAccessToken()
    let { resp, data } = await doFetch(token)
    if (resp.status === 401) {
      token = await this.getValidAccessToken(true)
      ;({ resp, data } = await doFetch(token))
    }
    if (!resp.ok) {
      throw new Error(`Google Ads API ${resp.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`)
    }
    return data
  }

  /**
   * Newline-delimited JSON parser for searchStream responses.
   * The Google Ads searchStream endpoint returns one JSON object per line.
   */
  private async callGadsSearchStream(
    customerId: string,
    body: Record<string, unknown>,
    loginCustomerId?: string,
  ): Promise<unknown[]> {
    if (!this.env.GADS_DEVELOPER_TOKEN) {
      throw new Error('Missing GADS_DEVELOPER_TOKEN secret.')
    }
    const url = `${this.apiBase()}/customers/${customerId}/googleAds:searchStream`
    const doFetch = async (token: string) => {
      const resp = await fetch(url, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: this.gadsHeaders(token, loginCustomerId),
      })
      const text = await resp.text()
      return { resp, text }
    }
    let token = await this.getValidAccessToken()
    let { resp, text } = await doFetch(token)
    if (resp.status === 401) {
      token = await this.getValidAccessToken(true)
      ;({ resp, text } = await doFetch(token))
    }
    if (!resp.ok) {
      throw new Error(`Google Ads searchStream ${resp.status}: ${text}`)
    }
    // The response is either a single JSON array or NDJSON. Handle both.
    const trimmed = text.trim()
    try {
      const parsed = JSON.parse(trimmed)
      return Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      return trimmed
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line))
    }
  }

  async init() {
    // ==================================================================
    // Account discovery
    // ==================================================================

    this.server.tool(
      'gads_list_accessible_customers',
      'List Google Ads customer IDs directly accessible to the authenticated user. Returns resource names like "customers/1234567890". Use this first to discover which accounts you can query.',
      {},
      async () => {
        const data = await this.callGads('/customers:listAccessibleCustomers', { method: 'GET' })
        return asTextResult(data)
      },
    )

    this.server.tool(
      'gads_get_customer',
      'Get details for a single Google Ads customer (descriptive name, currency, timezone, manager status, test account flag).',
      {
        customer_id: z.string().describe('Customer ID, 10 digits with or without dashes, e.g. 123-456-7890 or 1234567890'),
        login_customer_id: z
          .string()
          .optional()
          .describe('Override the manager (MCC) account used to access this customer. Defaults to env GADS_LOGIN_CUSTOMER_ID.'),
      },
      async ({ customer_id, login_customer_id }) => {
        const cid = normalizeCustomerId(customer_id)
        const query = `
          SELECT
            customer.id,
            customer.descriptive_name,
            customer.currency_code,
            customer.time_zone,
            customer.manager,
            customer.test_account,
            customer.auto_tagging_enabled,
            customer.tracking_url_template,
            customer.status
          FROM customer
          LIMIT 1
        `.trim()
        assertReadOnlyQuery(query)
        const data = await this.callGads(`/customers/${cid}/googleAds:search`, {
          method: 'POST',
          body: JSON.stringify({ query, pageSize: 1 }),
          loginCustomerId: login_customer_id,
        })
        return asTextResult(data)
      },
    )

    // ==================================================================
    // Raw GAQL query (read-only by design + defensive check)
    // ==================================================================

    this.server.tool(
      'gads_search',
      'Run an arbitrary read-only GAQL query against a Google Ads customer. Returns up to page_size rows plus a next_page_token. Use this for any custom report. See https://developers.google.com/google-ads/api/docs/query/overview for the query language.',
      {
        customer_id: z.string().describe('Customer ID, 10 digits, with or without dashes.'),
        query: z.string().describe('GAQL query. Must start with SELECT. No mutate/insert/update/delete.'),
        page_size: z.number().optional().default(1000).describe('Max rows per page, default 1000, max 10000.'),
        page_token: z.string().optional().describe('Pagination token from a previous response.'),
        login_customer_id: z.string().optional().describe('Override env GADS_LOGIN_CUSTOMER_ID for this call.'),
      },
      async ({ customer_id, query, page_size, page_token, login_customer_id }) => {
        assertReadOnlyQuery(query)
        const cid = normalizeCustomerId(customer_id)
        const body: Record<string, unknown> = { query, pageSize: Math.min(page_size ?? 1000, 10000) }
        if (page_token) body.pageToken = page_token
        const data = await this.callGads(`/customers/${cid}/googleAds:search`, {
          method: 'POST',
          body: JSON.stringify(body),
          loginCustomerId: login_customer_id,
        })
        return asTextResult(data)
      },
    )

    this.server.tool(
      'gads_search_stream',
      'Run a read-only GAQL query and return all rows in a single response. Use this when you expect more than a few thousand rows. No pagination needed. Larger payloads, slower.',
      {
        customer_id: z.string(),
        query: z.string().describe('GAQL query. Must start with SELECT.'),
        login_customer_id: z.string().optional(),
      },
      async ({ customer_id, query, login_customer_id }) => {
        assertReadOnlyQuery(query)
        const cid = normalizeCustomerId(customer_id)
        const chunks = await this.callGadsSearchStream(cid, { query }, login_customer_id)
        return asTextResult({ chunks_count: chunks.length, chunks })
      },
    )

    // ==================================================================
    // Convenience shortcuts (all backed by GAQL :search)
    // ==================================================================

    this.server.tool(
      'gads_list_campaigns',
      'List campaigns for a Google Ads customer with their core fields (id, name, status, advertising channel, budget). No metrics, no date range needed.',
      {
        customer_id: z.string(),
        status_filter: z
          .enum(['ALL', 'ENABLED', 'PAUSED', 'REMOVED'])
          .optional()
          .default('ENABLED')
          .describe('Filter by campaign status. Default ENABLED.'),
        limit: z.number().optional().default(500),
        login_customer_id: z.string().optional(),
      },
      async ({ customer_id, status_filter, limit, login_customer_id }) => {
        const cid = normalizeCustomerId(customer_id)
        const whereClause = status_filter && status_filter !== 'ALL' ? `WHERE campaign.status = '${status_filter}'` : ''
        const query = `
          SELECT
            campaign.id,
            campaign.name,
            campaign.status,
            campaign.advertising_channel_type,
            campaign.advertising_channel_sub_type,
            campaign.bidding_strategy_type,
            campaign.start_date,
            campaign.end_date,
            campaign_budget.amount_micros,
            campaign_budget.delivery_method
          FROM campaign
          ${whereClause}
          ORDER BY campaign.name
          LIMIT ${Math.min(limit ?? 500, 10000)}
        `.trim()
        assertReadOnlyQuery(query)
        const data = await this.callGads(`/customers/${cid}/googleAds:search`, {
          method: 'POST',
          body: JSON.stringify({ query, pageSize: Math.min(limit ?? 500, 10000) }),
          loginCustomerId: login_customer_id,
        })
        return asTextResult(data)
      },
    )

    this.server.tool(
      'gads_get_campaign_performance',
      'Performance per campaign over a date range: impressions, clicks, CTR, average CPC, cost, conversions, conversions value, ROAS, CPA. Date format: YYYY-MM-DD, or relative like LAST_7_DAYS, LAST_30_DAYS, THIS_MONTH, LAST_MONTH.',
      {
        customer_id: z.string(),
        date_range: z
          .string()
          .default('LAST_30_DAYS')
          .describe(
            "Use a predefined GAQL date range (LAST_7_DAYS, LAST_14_DAYS, LAST_30_DAYS, THIS_MONTH, LAST_MONTH, ALL_TIME, THIS_WEEK_SUN_TODAY, THIS_WEEK_MON_TODAY, LAST_BUSINESS_WEEK, LAST_WEEK_SUN_SAT, LAST_WEEK_MON_SUN) or 'CUSTOM' with start_date/end_date.",
          ),
        start_date: z.string().optional().describe('YYYY-MM-DD, only used when date_range is CUSTOM.'),
        end_date: z.string().optional().describe('YYYY-MM-DD, only used when date_range is CUSTOM.'),
        limit: z.number().optional().default(500),
        login_customer_id: z.string().optional(),
      },
      async ({ customer_id, date_range, start_date, end_date, limit, login_customer_id }) => {
        const cid = normalizeCustomerId(customer_id)
        const dateClause =
          date_range === 'CUSTOM'
            ? `segments.date BETWEEN '${start_date}' AND '${end_date}'`
            : `segments.date DURING ${date_range}`
        const query = `
          SELECT
            campaign.id,
            campaign.name,
            campaign.status,
            campaign.advertising_channel_type,
            metrics.impressions,
            metrics.clicks,
            metrics.ctr,
            metrics.average_cpc,
            metrics.cost_micros,
            metrics.conversions,
            metrics.conversions_value,
            metrics.cost_per_conversion,
            metrics.value_per_conversion
          FROM campaign
          WHERE ${dateClause}
          ORDER BY metrics.cost_micros DESC
          LIMIT ${Math.min(limit ?? 500, 10000)}
        `.trim()
        assertReadOnlyQuery(query)
        const data = await this.callGads(`/customers/${cid}/googleAds:search`, {
          method: 'POST',
          body: JSON.stringify({ query, pageSize: Math.min(limit ?? 500, 10000) }),
          loginCustomerId: login_customer_id,
        })
        return asTextResult(data)
      },
    )

    this.server.tool(
      'gads_list_ad_groups',
      'List ad groups for a customer, optionally filtered by campaign and status.',
      {
        customer_id: z.string(),
        campaign_id: z.string().optional().describe('Restrict to a specific campaign id.'),
        status_filter: z.enum(['ALL', 'ENABLED', 'PAUSED', 'REMOVED']).optional().default('ENABLED'),
        limit: z.number().optional().default(500),
        login_customer_id: z.string().optional(),
      },
      async ({ customer_id, campaign_id, status_filter, limit, login_customer_id }) => {
        const cid = normalizeCustomerId(customer_id)
        const conditions: string[] = []
        if (campaign_id) conditions.push(`campaign.id = ${campaign_id}`)
        if (status_filter && status_filter !== 'ALL') conditions.push(`ad_group.status = '${status_filter}'`)
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
        const query = `
          SELECT
            ad_group.id,
            ad_group.name,
            ad_group.status,
            ad_group.type,
            campaign.id,
            campaign.name,
            ad_group.cpc_bid_micros
          FROM ad_group
          ${where}
          ORDER BY ad_group.name
          LIMIT ${Math.min(limit ?? 500, 10000)}
        `.trim()
        assertReadOnlyQuery(query)
        const data = await this.callGads(`/customers/${cid}/googleAds:search`, {
          method: 'POST',
          body: JSON.stringify({ query, pageSize: Math.min(limit ?? 500, 10000) }),
          loginCustomerId: login_customer_id,
        })
        return asTextResult(data)
      },
    )

    this.server.tool(
      'gads_get_keyword_performance',
      'Performance per keyword over a date range: keyword text, match type, quality score, impressions, clicks, cost, conversions.',
      {
        customer_id: z.string(),
        campaign_id: z.string().optional(),
        ad_group_id: z.string().optional(),
        date_range: z.string().default('LAST_30_DAYS'),
        start_date: z.string().optional(),
        end_date: z.string().optional(),
        limit: z.number().optional().default(1000),
        login_customer_id: z.string().optional(),
      },
      async ({ customer_id, campaign_id, ad_group_id, date_range, start_date, end_date, limit, login_customer_id }) => {
        const cid = normalizeCustomerId(customer_id)
        const conditions: string[] = []
        if (date_range === 'CUSTOM') conditions.push(`segments.date BETWEEN '${start_date}' AND '${end_date}'`)
        else conditions.push(`segments.date DURING ${date_range}`)
        if (campaign_id) conditions.push(`campaign.id = ${campaign_id}`)
        if (ad_group_id) conditions.push(`ad_group.id = ${ad_group_id}`)
        const query = `
          SELECT
            campaign.id,
            campaign.name,
            ad_group.id,
            ad_group.name,
            ad_group_criterion.criterion_id,
            ad_group_criterion.keyword.text,
            ad_group_criterion.keyword.match_type,
            ad_group_criterion.quality_info.quality_score,
            metrics.impressions,
            metrics.clicks,
            metrics.ctr,
            metrics.average_cpc,
            metrics.cost_micros,
            metrics.conversions,
            metrics.conversions_value
          FROM keyword_view
          WHERE ${conditions.join(' AND ')}
          ORDER BY metrics.cost_micros DESC
          LIMIT ${Math.min(limit ?? 1000, 10000)}
        `.trim()
        assertReadOnlyQuery(query)
        const data = await this.callGads(`/customers/${cid}/googleAds:search`, {
          method: 'POST',
          body: JSON.stringify({ query, pageSize: Math.min(limit ?? 1000, 10000) }),
          loginCustomerId: login_customer_id,
        })
        return asTextResult(data)
      },
    )

    this.server.tool(
      'gads_get_search_terms_report',
      'Search terms report: actual user queries that triggered the ads, with their performance. Essential for finding negative keyword candidates.',
      {
        customer_id: z.string(),
        campaign_id: z.string().optional(),
        date_range: z.string().default('LAST_30_DAYS'),
        start_date: z.string().optional(),
        end_date: z.string().optional(),
        min_impressions: z.number().optional().default(0).describe('Filter out search terms with fewer impressions than this.'),
        limit: z.number().optional().default(1000),
        login_customer_id: z.string().optional(),
      },
      async ({ customer_id, campaign_id, date_range, start_date, end_date, min_impressions, limit, login_customer_id }) => {
        const cid = normalizeCustomerId(customer_id)
        const conditions: string[] = []
        if (date_range === 'CUSTOM') conditions.push(`segments.date BETWEEN '${start_date}' AND '${end_date}'`)
        else conditions.push(`segments.date DURING ${date_range}`)
        if (campaign_id) conditions.push(`campaign.id = ${campaign_id}`)
        if (min_impressions && min_impressions > 0) conditions.push(`metrics.impressions >= ${min_impressions}`)
        const query = `
          SELECT
            campaign.id,
            campaign.name,
            ad_group.id,
            ad_group.name,
            search_term_view.search_term,
            search_term_view.status,
            metrics.impressions,
            metrics.clicks,
            metrics.ctr,
            metrics.cost_micros,
            metrics.conversions,
            metrics.conversions_value
          FROM search_term_view
          WHERE ${conditions.join(' AND ')}
          ORDER BY metrics.impressions DESC
          LIMIT ${Math.min(limit ?? 1000, 10000)}
        `.trim()
        assertReadOnlyQuery(query)
        const data = await this.callGads(`/customers/${cid}/googleAds:search`, {
          method: 'POST',
          body: JSON.stringify({ query, pageSize: Math.min(limit ?? 1000, 10000) }),
          loginCustomerId: login_customer_id,
        })
        return asTextResult(data)
      },
    )

    this.server.tool(
      'gads_get_ad_performance',
      'Performance per ad (asset/creative) over a date range. Returns ad id, ad type, final URLs, impressions, clicks, conversions.',
      {
        customer_id: z.string(),
        campaign_id: z.string().optional(),
        ad_group_id: z.string().optional(),
        date_range: z.string().default('LAST_30_DAYS'),
        start_date: z.string().optional(),
        end_date: z.string().optional(),
        limit: z.number().optional().default(500),
        login_customer_id: z.string().optional(),
      },
      async ({ customer_id, campaign_id, ad_group_id, date_range, start_date, end_date, limit, login_customer_id }) => {
        const cid = normalizeCustomerId(customer_id)
        const conditions: string[] = []
        if (date_range === 'CUSTOM') conditions.push(`segments.date BETWEEN '${start_date}' AND '${end_date}'`)
        else conditions.push(`segments.date DURING ${date_range}`)
        if (campaign_id) conditions.push(`campaign.id = ${campaign_id}`)
        if (ad_group_id) conditions.push(`ad_group.id = ${ad_group_id}`)
        const query = `
          SELECT
            campaign.id,
            campaign.name,
            ad_group.id,
            ad_group.name,
            ad_group_ad.ad.id,
            ad_group_ad.ad.type,
            ad_group_ad.ad.final_urls,
            ad_group_ad.status,
            metrics.impressions,
            metrics.clicks,
            metrics.ctr,
            metrics.cost_micros,
            metrics.conversions,
            metrics.conversions_value
          FROM ad_group_ad
          WHERE ${conditions.join(' AND ')}
          ORDER BY metrics.impressions DESC
          LIMIT ${Math.min(limit ?? 500, 10000)}
        `.trim()
        assertReadOnlyQuery(query)
        const data = await this.callGads(`/customers/${cid}/googleAds:search`, {
          method: 'POST',
          body: JSON.stringify({ query, pageSize: Math.min(limit ?? 500, 10000) }),
          loginCustomerId: login_customer_id,
        })
        return asTextResult(data)
      },
    )

    this.server.tool(
      'gads_list_conversion_actions',
      'List conversion actions configured on the account (name, category, status, primary/secondary, attribution model, value).',
      {
        customer_id: z.string(),
        limit: z.number().optional().default(500),
        login_customer_id: z.string().optional(),
      },
      async ({ customer_id, limit, login_customer_id }) => {
        const cid = normalizeCustomerId(customer_id)
        const query = `
          SELECT
            conversion_action.id,
            conversion_action.name,
            conversion_action.category,
            conversion_action.status,
            conversion_action.type,
            conversion_action.primary_for_goal,
            conversion_action.counting_type,
            conversion_action.click_through_lookback_window_days,
            conversion_action.view_through_lookback_window_days,
            conversion_action.attribution_model_settings.attribution_model,
            conversion_action.value_settings.default_value
          FROM conversion_action
          LIMIT ${Math.min(limit ?? 500, 10000)}
        `.trim()
        assertReadOnlyQuery(query)
        const data = await this.callGads(`/customers/${cid}/googleAds:search`, {
          method: 'POST',
          body: JSON.stringify({ query, pageSize: Math.min(limit ?? 500, 10000) }),
          loginCustomerId: login_customer_id,
        })
        return asTextResult(data)
      },
    )

    this.server.tool(
      'gads_get_change_event_history',
      'Change history events on the account (who changed what, when). Limited to the last 30 days by the Google Ads API.',
      {
        customer_id: z.string(),
        start_date: z.string().describe('YYYY-MM-DD, must be within the last 30 days.'),
        end_date: z.string().describe('YYYY-MM-DD'),
        limit: z.number().optional().default(500),
        login_customer_id: z.string().optional(),
      },
      async ({ customer_id, start_date, end_date, limit, login_customer_id }) => {
        const cid = normalizeCustomerId(customer_id)
        const query = `
          SELECT
            change_event.change_date_time,
            change_event.user_email,
            change_event.client_type,
            change_event.change_resource_type,
            change_event.changed_fields,
            change_event.old_resource,
            change_event.new_resource,
            change_event.resource_change_operation,
            change_event.campaign,
            change_event.ad_group,
            change_event.feed
          FROM change_event
          WHERE change_event.change_date_time BETWEEN '${start_date} 00:00:00' AND '${end_date} 23:59:59'
          ORDER BY change_event.change_date_time DESC
          LIMIT ${Math.min(limit ?? 500, 10000)}
        `.trim()
        assertReadOnlyQuery(query)
        const data = await this.callGads(`/customers/${cid}/googleAds:search`, {
          method: 'POST',
          body: JSON.stringify({ query, pageSize: Math.min(limit ?? 500, 10000) }),
          loginCustomerId: login_customer_id,
        })
        return asTextResult(data)
      },
    )

    this.server.tool(
      'gads_get_account_summary',
      'Account-level KPIs over a date range: total impressions, clicks, cost, conversions, conversions value, CTR, CPC, CPA, ROAS.',
      {
        customer_id: z.string(),
        date_range: z.string().default('LAST_30_DAYS'),
        start_date: z.string().optional(),
        end_date: z.string().optional(),
        login_customer_id: z.string().optional(),
      },
      async ({ customer_id, date_range, start_date, end_date, login_customer_id }) => {
        const cid = normalizeCustomerId(customer_id)
        const dateClause =
          date_range === 'CUSTOM'
            ? `segments.date BETWEEN '${start_date}' AND '${end_date}'`
            : `segments.date DURING ${date_range}`
        const query = `
          SELECT
            customer.id,
            customer.descriptive_name,
            customer.currency_code,
            metrics.impressions,
            metrics.clicks,
            metrics.ctr,
            metrics.average_cpc,
            metrics.cost_micros,
            metrics.conversions,
            metrics.conversions_value,
            metrics.cost_per_conversion,
            metrics.value_per_conversion
          FROM customer
          WHERE ${dateClause}
        `.trim()
        assertReadOnlyQuery(query)
        const data = await this.callGads(`/customers/${cid}/googleAds:search`, {
          method: 'POST',
          body: JSON.stringify({ query }),
          loginCustomerId: login_customer_id,
        })
        return asTextResult(data)
      },
    )

    // ==================================================================
    // Metadata helper
    // ==================================================================

    this.server.tool(
      'gads_list_fields',
      'Discover Google Ads API fields available for GAQL queries. Returns names, categories (RESOURCE, ATTRIBUTE, SEGMENT, METRIC), data type, and selectable/filterable/sortable flags. Account-agnostic.',
      {
        filter: z
          .string()
          .optional()
          .describe(
            "Optional GAQL WHERE clause on googleAdsField, e.g. \"name LIKE 'metrics%'\" or \"category = 'METRIC' AND selectable = true\".",
          ),
        limit: z.number().optional().default(500),
        login_customer_id: z.string().optional(),
      },
      async ({ filter, limit, login_customer_id }) => {
        const whereClause = filter && filter.trim().length > 0 ? `WHERE ${filter.trim()}` : ''
        const query = `
          SELECT
            google_ads_field.name,
            google_ads_field.category,
            google_ads_field.data_type,
            google_ads_field.selectable,
            google_ads_field.filterable,
            google_ads_field.sortable,
            google_ads_field.is_repeated
          FROM google_ads_field
          ${whereClause}
          LIMIT ${Math.min(limit ?? 500, 10000)}
        `.trim()
        assertReadOnlyQuery(query)
        const data = await this.callGads(`/googleAdsFields:search`, {
          method: 'POST',
          body: JSON.stringify({ query, pageSize: Math.min(limit ?? 500, 10000) }),
          loginCustomerId: login_customer_id,
        })
        return asTextResult(data)
      },
    )
  }
}

export default new OAuthProvider({
  apiHandler: MyMCP.mount('/sse') as any,
  apiRoute: '/sse',
  authorizeEndpoint: '/authorize',
  clientRegistrationEndpoint: '/register',
  defaultHandler: GoogleHandler as any,
  tokenEndpoint: '/token',
})
