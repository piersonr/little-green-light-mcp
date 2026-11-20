# little-green-light-mcp

A [MCP](https://modelcontextprotocol.io) server for the Little Green Light donor CRM.
Any stdio MCP client can look up constituents, list gifts in a date range, fetch
one person's giving history, and preview and apply approved constituent name and
street-address edits.

The server name is `lgl-mcp`. How you register it depends on the host — see Setup.

## Bounded name updates

The eight lookup tools remain read-only: `lgl.js` exposes only a `GET` request function.
Two separate modules hold the only write transports. `name-updates.js` sends a
single name-only `PATCH` to an existing constituent. `address-updates.js` (below)
adds one street address or edits one existing one. There are no delete, gift,
email, phone, group, note, or relationship write tools, and no way to create a
constituent. Both writers share one per-constituent lock, so a name update and an
address update never overlap on the same record.

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

## Bounded street-address updates

`address-updates.js` is the second isolated write transport. It follows the same
pattern as name updates: a read-only preview, a one-use confirmation token, a stale
check on apply, exactly one write with no retries, then a re-read that verifies the
result.

1. `list_constituent_addresses(id)` shows every street address with its id, street,
   city, state, postal code, country, type, `is_preferred` and `not_current`.
2. `preview_constituent_address_update(id, action, ...)` writes nothing. Actions:
   - `add` with `address: {street, city, state, postal_code, address_type?}` and an
     optional `make_preferred: true`.
   - `update` with `address_id` and only the fields to change, and/or
     `make_preferred: true`.
   - `mark_inactive` with `address_id`, which sets LGL's `not_current` flag.

   It re-reads the constituent and its address list and returns the current
   addresses, the exact addresses after the change, the exact request body, and a
   token tied to a fingerprint of the profile plus every address.
3. `apply_constituent_address_update(confirmation_token, confirmed: true)` re-reads
   and refuses if anything changed, sends one `POST` or `PATCH`, then re-reads and
   checks the target address, every other address and every profile field.
   Mismatches come back as `verification_failed` with a `problems` list and the tool
   result flagged as an error. Nothing is retried or rolled back automatically.

Endpoints, confirmed in LGL's API docs (`api-docs/static.html`, "Street Address
Management") and a read-only GET of a live record on 2026-11-19:

| Purpose | Endpoint |
|---|---|
| List | `GET /constituents/{id}/street_addresses` |
| Create one | `POST /constituents/{id}/street_addresses` (adds; does not replace others) |
| Update one | `PATCH /street_addresses/{id}` |
| Address types | `GET /types/street_address_types` (Home 1, Work 2, Other 3, School 4) |

Fields sent: `street`, `city`, `state`, `postal_code`, `street_address_type_id`,
`is_preferred`, `not_current`. Every PATCH re-sends the address's current street,
city, state, ZIP and type alongside the change, so none of them is left to LGL's
defaults. County, country and seasonal fields are never sent. A new address is
verified to have come back with no country, county or seasonal setting.
`DELETE /street_addresses/{id}` exists in LGL but is deliberately not implemented.

Rules built in because of LGL behavior seen in the October 2026 cleanup (AGENTS.md):

- Every write sends `is_preferred` and `not_current` explicitly. A PATCH that
  omits them silently reactivates an inactive address and makes it preferred.
- The preferred flag is never cleared on an address that has siblings, because LGL
  then promotes another address of its own choosing. To retire a preferred address,
  first add or update the replacement with `make_preferred: true` (the preview shows
  the old one losing the flag), then `mark_inactive` the old one.
- A new address is made preferred by default when the constituent has no current
  preferred address; pass `make_preferred: false` to override.
- Input is validated: two-letter US state or territory codes, ZIP or ZIP+4, a
  non-empty street, and no city, state or ZIP packed onto the end of `street`. Only US addresses
  can be edited, and a new address cannot duplicate an active one.

Address updates are tested offline with a simulated LGL and a stdio MCP exchange.
No live address write was made during development. LGL's real acceptance of these
payloads, and whether it clears the old preferred flag when a new address is made
preferred, get confirmed by the first approved edit. Verification reports it if not.

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
| `list_constituent_addresses` | Read-only list of one constituent's street addresses with ids and flags. |
| `preview_constituent_address_update` | Read-only preview of an add, update or mark-inactive; returns a one-use token. |
| `apply_constituent_address_update` | Apply an explicitly approved address preview and verify every address and profile field. |
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
npm run audit:readonly   # static check: write methods isolated to the two update modules
npm test                 # offline service, transport, and stdio MCP tests
npm run audit:safety     # both checks above
```

## Rate limits

LGL allows 300 API calls per 5-minute window. Both transports share a sliding-window
throttle. GET requests retry with backoff on 429/5xx. Each writer sends a single
PATCH or POST without retries, then verifies with GET. Restart or reconnect the MCP client
after installing an update so it discovers the new tools; existing client
registration and credentials do not need to change.
