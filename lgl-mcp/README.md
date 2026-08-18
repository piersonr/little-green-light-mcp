# lgl-mcp

A read-only [MCP](https://modelcontextprotocol.io) server for the Little Green Light donor CRM.
Lets Claude answer questions like "who lapsed this year?", "did the Smith gift land?", or
"what's year-to-date against last year?" by querying LGL directly.

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
4. Register with Claude Code:
   ```bash
   claude mcp add lgl -- node /Users/robpierson/Documents/projects/mcf-funding/lgl-mcp/index.js
   ```

## Tools

| Tool | What it does |
|---|---|
| `search_constituents` | Search by name or email. |
| `get_constituent` | Full profile for one constituent by id. |
| `get_constituent_gifts` | Giving history for one constituent. |
| `search_gifts` | Search gifts by date range, amount, or fund. |
| `list_funds` | All configured funds (cached). |
| `list_appeals` | All configured appeals (cached). |
| `list_gift_categories` | All configured gift categories (cached). |
| `list_gift_types` | All configured gift types (cached). |

Every tool accepts `verbose: true` to get the full LGL object instead of the trimmed summary
(id, name, email, phone, city/state, giving dates, lifetime total, etc.). List responses that
are capped include a `note` field saying how many results were omitted — nothing is silently
truncated.

## Known open item

`search_constituents`'s exact query syntax is unconfirmed against a live account — LGL's
published docs describe `q[]=` params, a community MCP server uses `search=`. The tool tries
`q[]=` first and falls back to `search=` on a 422. Confirm which one the live account actually
wants once a key is available, and simplify this to a single call.

## Development

```bash
npm run inspect          # MCP Inspector — exercise tools interactively
npm run audit:readonly   # mechanical check: no POST/PATCH/PUT/DELETE anywhere
```

## Rate limits

LGL allows 300 API calls per 5-minute window. `lgl.js` throttles internally (sliding window)
and retries with backoff on 429/5xx, so a broad question that fans out into many calls degrades
gracefully instead of erroring.
