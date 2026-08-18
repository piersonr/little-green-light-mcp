# little-green-light-mcp

A read-only [MCP](https://modelcontextprotocol.io) server for the Little Green Light donor CRM.
Any stdio MCP client can use it to look up constituents, list gifts in a date range, or fetch
one person's giving history.

The server name is `lgl-mcp`. How you register it depends on the host — see Setup.

## Read-only by construction

This server has **no create, update, or delete tools** — not disabled, absent. `lgl.js` exposes
only a `GET` request function; there is no code path anywhere in this project that can mutate a
donor record. Run `npm run audit:readonly` after any change to confirm mechanically.

Any future write path (e.g. syncing donations) belongs in LGL's own reviewed Integration Queue,
not here.

## Setup

1. Get an API key from LGL: **Settings → Integration Settings → LGL API**.
2. Put it in `~/.config/lgl-mcp/env` (already created, chmod 600):
   ```
   LGL_API_KEY=your-key-here
   ```
   Alternatively, add a macOS Keychain item named `lgl-api-key`, or set the `LGL_API_KEY`
   environment variable for a one-off run. The key is never logged, committed, or echoed in
   error messages.
3. Install dependencies (already done on first checkout):
   ```bash
   npm install
   ```
4. Point a stdio MCP host at this server. The command is `node`; the argument is the
   absolute path to `index.js`:
   ```json
   {
     "command": "node",
     "args": ["/absolute/path/to/little-green-light-mcp/index.js"]
   }
   ```
   Wrap that in whatever config shape your host uses (`mcpServers`, a top-level
   server map, and so on). No extra env vars are required if the key is in
   `~/.config/lgl-mcp/env` or Keychain. Set `LGL_API_KEY` in the host's env
   block only for a one-off override.

## Tools

| Tool | What it does |
|---|---|
| `search_constituents` | Search by name or exact email address. Compact rows are identity only — no giving totals. |
| `get_constituent` | Full profile for one constituent by id, including giving totals computed from the full gift history (0 if none). |
| `get_constituent_gifts` | Giving history for one constituent. |
| `search_gifts` | Search gifts by date range, across all constituents. |
| `list_funds` | All configured funds (cached). |
| `list_appeals` | All configured appeals (cached). |
| `list_gift_categories` | All configured gift categories (cached). |
| `list_gift_types` | All configured gift types (cached). |

Every tool accepts `verbose: true` to get the full LGL object instead of the trimmed summary.
Compact constituents include name, email, phone, and city/state. Giving dates and lifetime
total are only on `get_constituent`. Compact gifts include date, amount, fund_id, note, and
donor name (when expanded). List responses that are capped include a `note` field saying how
many results were omitted — nothing is silently truncated.

## Confirmed query syntax

LGL's `/constituents/search` and `/gifts/search` take `q[]=field=value` pairs, not free text —
this was undocumented for several fields and confirmed by probing a live account:

- Constituents: `name=<text>` (LGL's own documented example) or `eaddr=<email>` for an exact
  email match (undocumented; guesses like `email=`/`email_address=` were rejected).
- Gifts: `date_from=YYYY-MM-DD` / `date_to=YYYY-MM-DD` (confirmed real filters — an
  out-of-range date zeroes `total_items`). Multiple `q[]` entries AND together.
- Gifts have **no fund or amount filter** on this endpoint — `fund_id`, `fund`, `fund_ids`,
  `campaign_id`, `amount_from`, `amount_to` were all tried and rejected as unknown parameters.
  `search_gifts` doesn't expose these; filter results client-side on `fund_id` / `note` if needed.
- A gift's donor name only appears when the request includes
  `expand=first_name,last_name,org_name` — LGL doesn't nest a constituent object in the gift
  response otherwise.
- `get_constituent`'s giving totals (first/last gift date, lifetime amount) aren't returned by
  LGL on the constituent object at all — they're computed here from that constituent's own gift
  history, paged to completion. A constituent with no gifts returns `lifetime_amount: 0`. A
  safety cap still applies (10,000 gifts); the response says so if it is hit.

## Development

```bash
npm run inspect          # MCP Inspector — exercise tools interactively
npm run audit:readonly   # mechanical check: no POST/PATCH/PUT/DELETE anywhere
```

## Rate limits

LGL allows 300 API calls per 5-minute window. `lgl.js` throttles internally (sliding window)
and retries with backoff on 429/5xx, so a broad question that fans out into many calls degrades
gracefully instead of erroring.
