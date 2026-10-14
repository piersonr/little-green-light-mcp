# Agent Rules — Little Green Light (MCF)

Operating knowledge for working against the Moraga Community Foundation's Little
Green Light account. Everything here was verified against the live account on
**2026-10-14** unless noted. Re-verify before relying on an id or a behavior.

## This repo is read-only by construction

`lgl.js` exposes only a GET request function. Keep it that way, and run
`npm run audit:readonly` after any change. Writes to LGL belong in a separate
one-off script outside this repo (the scratchpad is the right home), or in the
`mcf-peer-fundraising` WordPress plugin, which owns the automated write path.

## Deletions are Rob's to perform

Never delete LGL records — constituents, gifts, addresses, groups. Surface what
should go, with ids and exact text, and let Rob act. This holds even when he
asks directly.

**Never use Bulk edit → Delete constituents to clean up addresses.** It erases
the donors and everything attached: gifts, notes, tasks, event attendance.
Deleting a street address is safe by contrast — gifts carry `constituent_id` and
have no reference to an address.

## API behaviors that have already caused damage

- **A PATCH to `/street_addresses/{id}` that omits `is_preferred` and
  `not_current` silently flips an Inactive address to active *and* preferred.**
  Sending only street/city/state/postal_code did this to 4 records during the
  October address cleanup. Always send both flags explicitly, and re-read the
  record afterward — nothing in the response signals the change.
- **Unsetting `is_preferred` promotes another address automatically.** Clearing
  the preferred flag on one address made a second junk address preferred on the
  same constituent. Re-read the whole constituent after any flag change.
- **`PATCH /gifts/{id}` with `ack_template_name` returned HTTP 200 and did not
  change the value.** Do not trust a 200 here; verify by re-reading the gift.
- **There is no `GET /gifts` collection** — it 404s. Use
  `/gifts/search?q[]=date_from=YYYY-MM-DD`, which is also the only way to page
  the whole gift history.
- `expand=street_addresses` works on the `/constituents` list, so the entire
  account's addresses come back in two calls rather than one per constituent.
- Rate limit is 300 calls per 5 minutes, shared across concurrent scripts.

## Data conventions for this account

- **Never write a single-line address.** Street, city, state and postal code go
  in their own fields. 327 records had to be split in October because the
  original import jammed everything into `street`, which printed a bare comma
  where the city line belonged on acknowledgement letters.
- Leave `country` blank for US addresses; every existing record does.
- Record the **gross** gift amount. Donors who cover processing fees produce
  amounts like $102.53, and staff have always recorded what the donor paid.
- Do not overwrite `addressee`, `salutation` or name fields on an existing
  constituent from an incoming payment or form. LGL Forms has "Do not update
  constituent name information" ticked for this reason; 330 addressee records
  were cleaned up in October and a donor typing "bob" at checkout should not
  undo that.
- Addressee and salutation are generated from the name fields **when a record is
  created** and never recalculate afterward. Fixing a name does not fix them.

## Confirmed account ids

| Thing | Id |
|---|---|
| Fund: General Fund | 2459 |
| Fund: Shades (campaign-specific) | 2454 |
| Campaign: Shades for All Access Playground | 844 |
| Appeal: Website Donation | 3004 |
| Appeal: Shades | 2984 |
| Appeal: Peer Fundraising Pages | 2989 |
| Gift category: Donation | 6004 |
| Gift type: Gift / In Honor of / In Memory of | 1 / 10 / 11 |
| Payment type: Credit Card / Stripe | 1534 / 1549 |
| Ack template: Shade Campaign Donation Ack (**letter**) | 544 |
| Ack template: Shade (**email**) | 554 |

Fund, campaign and the Shade ack templates are campaign-specific and change when
the shade campaign ends. General Fund and the Website Donation appeal are the
durable choices for a general donation.

## How gifts actually reach LGL

| Channel | Path |
|---|---|
| LGL Forms on `/donate/` | Submission lands in **Forms → Submission Queue** and becomes a gift only when a human clicks Save |
| Peer fundraiser Stripe links | `mcf-peer-fundraising` plugin webhook, automatic |
| Standalone Stripe link (QR code at the Commons) | No sync as of 2026-10-14 |
| PayPal hosted button | No sync as of 2026-10-14 |

The Forms queue is the trap: a $500 donation sat there unnoticed for four days
in October because no submission notification was switched on. Notifications are
now enabled on both forms. A gift that is in Stripe but absent from LGL is
usually sitting in that queue, not lost.

Stripe payments carrying `form_name` metadata belong to LGL Forms. Any other
sync must skip them or the gift is recorded twice.

## The staff app

`https://moragacommunity.littlegreenlight.com` — not `app.littlegreenlight.com`,
which redirects to marketing. Useful paths:

- `/constituents/{id}` and `/constituents/{id}/contact_info`
- `/gifts/{id}`
- `/lgl_forms/queue/unsaved` — the submission queue
- `/constituents/search/group/{group_id}` — a group's members

LGL's UI uses native browser `confirm()` dialogs for deletes. Browser automation
cannot dismiss them and the page will appear to freeze; navigating away recovers
without performing the action.
