# little-green-light-mcp

A [MCP](https://modelcontextprotocol.io) server for the Little Green Light donor CRM.
Any stdio MCP client can look up constituents, list gifts in a date range, fetch
one person's giving history, and preview and apply an approved constituent name edit.

The server name is `lgl-mcp`. How you register it depends on the host — see Setup.

## Bounded name updates

The eight lookup tools remain read-only: `lgl.js` exposes only a `GET` request function.
The separate `name-updates.js` module implements the only write transport: a single
name-only `PATCH` to an existing constituent. There are no create, delete, gift,
contact-information, group, note, or relationship write tools.

1. Call `preview_constituent_name_update` with an exact constituent ID and explicit
   name fields. Resolve the constituent identity before preparing the preview.
2. Show the returned before/after changes to the user and obtain their approval of
   those exact changes. Creating a preview is not approval to apply it.
3. Call `apply_constituent_name_update` with that preview's `confirmation_token`
   and `confirmed: true` only after approval. The token is one-use and belongs to
   that server session; restarting clears outstanding previews.

The apply tool re-reads the complete constituent and refuses the update if any
returned data changed after preview. It sends only the changed name fields, then
re-reads and compares all name fields and other returned profile data. Only
`updated_at` and the derived `sort_name` are allowed to change additionally.
Already-correct names return `unchanged` and require no write.

Permitted fields: `prefix`, `first_name`, `middle_name`, `last_name`, `suffix`,
`spouse_name`, `org_name`, and `addressee` (the label/display name). For an individual,
`org_name` describes their employer and is refused. For an organization, only
`org_name` and `addressee` may be edited; contact-person names are refused. A linked
spouse's name must be edited on that person's own constituent. Spouse-field edits
are refused when relationships are missing or contain a spouse/partner link.
Blank strings explicitly clear an optional field; leaving a prospect with no name
is refused. A field omitted from the API response cannot be previewed or changed.
Adding a spouse to an addressee does not create or link another record.

Writes are never retried automatically, including timeouts, rate limits, and server
errors. A verification failure reports whether the saved names differed, unrelated
returned fields changed, or the saved record could not be read. Inspect LGL before
preparing another preview; the tool does not retry or roll back a failed verification.
Previews and locks are local to one server process. The API has no documented
conditional-update mechanism here, so another client could still edit between
the final read and PATCH. Verification detects returned differences; it cannot
make that interval atomic or verify data the API does not return.

### Native steward assignments: unavailable

On 2026-10-26, all 33 resource schemas in LGL's published API index were checked.
They expose constituent name updates, but no native steward, solicitor, or
relationship-manager assignment field or endpoint. This server therefore cannot
write native steward assignments. It does not substitute groups, custom fields,
or constituent relationships for the native Stewards feature.

LGL's [developer guidance](https://help.littlegreenlight.com/article/603-for-software-developers-using-the-lgl-api)
explains that not all fields are available through the API and directs requests
for additional fields to LGL support. A documented steward read/write endpoint
and its staff-ID mapping are needed to implement the remaining requested feature.

### Validation scope

Name updates are tested offline with simulated API responses, including a complete
stdio MCP preview/apply/verify exchange. No live donor update was used for testing.
The published constituent `UpdateBody` marks first/last names and email arrays as
required. The connector deliberately sends only the requested changed name fields;
if LGL rejects that narrow PATCH, it reports the error without resending contact
data or broadening the payload. Live acceptance of this narrow payload remains
unverified and needs an explicitly approved edit to an identified constituent.

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
| `preview_constituent_name_update` | Read-only preview of exact name changes; returns a one-use token. |
| `apply_constituent_name_update` | Apply an explicitly approved preview and verify the saved record. |
| `search_gifts` | Search gifts by date range, across all constituents. |
| `list_funds` | All configured funds (cached). |
| `list_appeals` | All configured appeals (cached). |
| `list_gift_categories` | All configured gift categories (cached). |
| `list_gift_types` | All configured gift types (cached). |

Every lookup tool accepts `verbose: true` to get the full LGL object instead of the trimmed summary.
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
npm run audit:readonly   # static check: write methods isolated to name-updates.js
npm test                 # offline service, transport, and stdio MCP tests
npm run audit:safety     # both checks above
```

## Rate limits

LGL allows 300 API calls per 5-minute window. Both transports share a sliding-window
throttle. GET requests retry with backoff on 429/5xx. The name writer sends a single
PATCH without retries, then verifies with GET. Restart or reconnect the MCP client
after installing an update so it discovers the new tools; existing client
registration and credentials do not need to change.
