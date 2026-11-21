#!/usr/bin/env node
// Little Green Light MCP: existing lookups remain read-only. Separate
// preview/apply pairs permit only name edits and street-address edits on
// existing constituents.
// Native Stewards are not exposed by the published LGL API.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { request, getList, getAllList, getCachedLookup, LglError } from "./lgl.js";
import { shapeConstituent, shapeGift, shapeLookup, summarizeGiving, truncationNote } from "./shape.js";
import { nameUpdates, NAME_FIELDS } from "./name-updates.js";
import { addressUpdates, ACTIONS, ADDRESS_TYPES } from "./address-updates.js";

const server = new McpServer({
  name: "lgl-mcp",
  version: "0.3.0",
  title: "Little Green Light (lookups, name and address updates)",
});

// --- shared helpers ----------------------------------------------------

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Wrap a handler so LglError produces a legible tool error instead of a stack trace. */
function safe(handler) {
  return async (args) => {
    try {
      return await handler(args);
    } catch (err) {
      if (err instanceof LglError) return errorResult(err.message);
      return errorResult(`Unexpected error: ${err.message}`);
    }
  };
}

const verboseParam = z
  .boolean()
  .optional()
  .describe("Return the full, untrimmed LGL object instead of the compact summary.");

const paginationParams = {
  limit: z.number().int().min(1).max(100).optional().describe("Max results (default 25, max 100)."),
  offset: z.number().int().min(0).optional().describe("Number of results to skip, for paging."),
};

function paginatedResult(items, shapeFn, verbose, meta) {
  // truncationNote wants {total, returned, limit, offset}; `meta` (the
  // getList() result) carries `items` instead of `returned` — bridge that
  // here rather than relying on a field that was never actually present.
  const note = truncationNote({ ...meta, returned: items.length });
  return textResult({
    results: items.map((item) => shapeFn(item, { verbose })),
    ...(note ? { note } : {}),
  });
}

// --- cached lookups: funds, appeals, gift categories, gift types -------

const LOOKUPS = [
  { name: "list_funds", path: "/funds", noun: "funds" },
  { name: "list_appeals", path: "/appeals", noun: "appeals" },
  { name: "list_gift_categories", path: "/gift_categories", noun: "gift categories" },
  { name: "list_gift_types", path: "/gift_types", noun: "gift types" },
];

for (const { name, path, noun } of LOOKUPS) {
  server.registerTool(
    name,
    {
      title: name,
      description:
        `List all ${noun} configured in LGL. Small, rarely-changing reference ` +
        `data — cached for this session after the first call.`,
      inputSchema: { verbose: verboseParam },
    },
    safe(async ({ verbose }) => {
      const { items, total, truncated } = await getCachedLookup(path);
      return textResult({
        results: items.map((item) => shapeLookup(item, { verbose })),
        ...(truncated
          ? { note: `Showing ${items.length} of ${total} total — this list exceeds the cached page size.` }
          : {}),
      });
    }),
  );
}

// --- constituents --------------------------------------------------------

// LGL's /constituents/search takes q[]=field=value pairs, not free text —
// confirmed against a live account (2026-08-18). "name=brady" is LGL's own
// documented example; "eaddr" for email was undocumented and found by
// probing the live API (guesses like "email"/"email_address" 400).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

server.registerTool(
  "search_constituents",
  {
    title: "search_constituents",
    description:
      "Search LGL constituents by name or email address. Returns a compact " +
      "summary per match (name, email, phone, city/state). Giving totals are " +
      "not included — use get_constituent for those. Pass verbose:true for " +
      "the full record.",
    inputSchema: {
      query: z
        .string()
        .min(1)
        .describe("A name (e.g. 'Pierson') or an email address to match exactly."),
      verbose: verboseParam,
      ...paginationParams,
    },
  },
  safe(async ({ query, verbose, limit, offset }) => {
    const field = EMAIL_RE.test(query) ? "eaddr" : "name";
    const list = await getList("/constituents/search", {
      "q[]": `${field}=${query}`,
      limit,
      offset,
    });
    return paginatedResult(list.items, shapeConstituent, verbose, list);
  }),
);

server.registerTool(
  "get_constituent",
  {
    title: "get_constituent",
    description: "Fetch one constituent's profile by LGL id, including giving totals computed from the full gift history.",
    inputSchema: {
      id: z.union([z.string(), z.number()]).describe("LGL constituent id."),
      verbose: verboseParam,
    },
  },
  safe(async ({ id, verbose }) => {
    const raw = await request(`/constituents/${id}`);
    if (verbose) return textResult(shapeConstituent(raw, { verbose }));

    // LGL doesn't return giving totals on the constituent object itself —
    // compute them from that constituent's own gift history, paged to
    // completion (getAllList has a high safety cap and reports truncated).
    const giftsPage = await getAllList(`/constituents/${id}/gifts`);
    const giving = summarizeGiving(giftsPage.items, {
      totalCount: giftsPage.total,
      sampledCount: giftsPage.items.length,
    });
    return textResult(shapeConstituent(raw, { verbose, giving }));
  }),
);

server.registerTool(
  "get_constituent_gifts",
  {
    title: "get_constituent_gifts",
    description: "List the giving history for one constituent, most recent first.",
    inputSchema: {
      id: z.union([z.string(), z.number()]).describe("LGL constituent id."),
      verbose: verboseParam,
      ...paginationParams,
    },
  },
  safe(async ({ id, verbose, limit, offset }) => {
    const list = await getList(`/constituents/${id}/gifts`, { limit, offset });
    return paginatedResult(list.items, shapeGift, verbose, list);
  }),
);

// --- narrowly scoped constituent name updates ------------------------------

server.registerTool(
  "preview_constituent_name_update",
  {
    title: "Preview a prospect name change",
    description:
      "Read an existing constituent and preview exact name-field changes. " +
      "Returns a one-use confirmation token. Does not write. Show the preview " +
      "to the user and obtain approval before applying it, including any " +
      "expected_side_effects (fields LGL changes on its own, such as alt_addressee " +
      "following a new addressee). Native steward " +
      "assignments are not supported by LGL's published API.",
    inputSchema: {
      id: z.union([z.string().regex(/^[1-9]\d*$/), z.number().int().positive()]),
      changes: z.object(Object.fromEntries(NAME_FIELDS.map(field => [
        field, z.string().max(250).optional(),
      ]))).strict().describe("Only the explicitly requested name fields. Blank strings explicitly clear a field."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  safe(async args => textResult(await nameUpdates.preview(args))),
);

server.registerTool(
  "apply_constituent_name_update",
  {
    title: "Apply an approved prospect name change",
    description:
      "Write only the name changes in an approved preview for one existing " +
      "constituent. Requires explicit user approval of that preview. Re-reads " +
      "the record first, refuses stale previews, sends one name-only PATCH " +
      "without retries, then re-reads and verifies the saved names and other " +
      "profile fields. Does not create constituents or edit stewards, contact " +
      "information, gifts, groups, notes, or relationships.",
    inputSchema: {
      confirmation_token: z.string().regex(/^[a-f0-9]{48}$/),
      confirmed: z.literal(true).describe("True only after the user approves the exact preview."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  safe(async args => {
    const result = await nameUpdates.apply(args);
    return { ...textResult(result), ...(result.verified === false ? { isError: true } : {}) };
  }),
);

// --- narrowly scoped street-address updates --------------------------------

server.registerTool(
  "list_constituent_addresses",
  {
    title: "List a constituent's street addresses",
    description:
      "Read-only. Every street address on one constituent with its address id, " +
      "street, city, state, postal_code, country, address type, preferred flag " +
      "and not_current (inactive) flag.",
    inputSchema: { id: z.union([z.string().regex(/^[1-9]\d*$/), z.number().int().positive()]) },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  safe(async args => textResult(await addressUpdates.list(args))),
);

server.registerTool(
  "preview_constituent_address_update",
  {
    title: "Preview a street-address change",
    description:
      "Does not write. Re-reads the constituent and previews one address change: " +
      "'add' a new US address (optionally make_preferred), 'update' fields on one " +
      "existing address by address_id (optionally make_preferred: true), or " +
      "'mark_inactive' to set not_current on one address by address_id. Shows " +
      "current addresses next to the exact result and returns a one-use " +
      "confirmation token. Show the preview to the user and obtain approval " +
      "before applying. A preferred address cannot be marked inactive while " +
      "other addresses exist; make the right address preferred first. Deleting " +
      "addresses is not supported.",
    inputSchema: {
      id: z.union([z.string().regex(/^[1-9]\d*$/), z.number().int().positive()]).describe("LGL constituent id."),
      action: z.enum(ACTIONS),
      address_id: z.union([z.string().regex(/^[1-9]\d*$/), z.number().int().positive()]).optional()
        .describe("Required for update and mark_inactive."),
      address: z.object({
        street: z.string().max(250).optional().describe("Street lines only; never city/state/ZIP. Use a newline for a second line."),
        city: z.string().max(100).optional(),
        state: z.string().max(30).optional().describe("Two-letter US state or territory code."),
        postal_code: z.string().max(10).optional().describe("12345 or 12345-6789."),
        address_type: z.enum(ADDRESS_TYPES).optional().describe("Defaults to Home for a new address."),
      }).strict().optional().describe("For add (street, city, state, postal_code required) or update (only fields to change)."),
      make_preferred: z.boolean().optional().describe("add/update only: make this the preferred address."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  safe(async args => textResult(await addressUpdates.preview(args))),
);

server.registerTool(
  "apply_constituent_address_update",
  {
    title: "Apply an approved street-address change",
    description:
      "Write the single address change in an approved preview. Requires explicit " +
      "user approval of that preview. Re-reads the constituent and its addresses " +
      "first and refuses if anything changed, sends exactly one POST or PATCH " +
      "without retries, then re-reads and verifies the saved address, every " +
      "other address and the profile fields. Never deletes addresses or edits " +
      "gifts, emails, phones, groups, notes or relationships.",
    inputSchema: {
      confirmation_token: z.string().regex(/^[a-f0-9]{48}$/),
      confirmed: z.literal(true).describe("True only after the user approves the exact preview."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  safe(async args => {
    const result = await addressUpdates.apply(args);
    return { ...textResult(result), ...(result.verified === false ? { isError: true } : {}) };
  }),
);

// --- gifts -----------------------------------------------------------------

// Confirmed against a live account (2026-08-18): date_from/date_to are real
// filters (an out-of-range date zeroes total_items). fund_id, fund, fund_ids,
// campaign_id, amount_from/amount_to were all tried and rejected as unknown
// query parameters — LGL does not appear to expose fund/amount filtering on
// this endpoint, so it's left out here rather than silently ignored.
server.registerTool(
  "search_gifts",
  {
    title: "search_gifts",
    description:
      "Search gifts across all constituents by date range. Useful for totals " +
      "and reconciliation questions (e.g. 'gifts in 2025'). Fund/amount " +
      "filtering isn't exposed by LGL's search endpoint — filter the results " +
      "client-side if needed.",
    inputSchema: {
      from_date: z.string().optional().describe("YYYY-MM-DD, inclusive."),
      to_date: z.string().optional().describe("YYYY-MM-DD, inclusive."),
      verbose: verboseParam,
      ...paginationParams,
    },
  },
  safe(async ({ from_date, to_date, verbose, limit, offset }) => {
    const terms = [];
    if (from_date) terms.push(`date_from=${from_date}`);
    if (to_date) terms.push(`date_to=${to_date}`);

    const list = await getList("/gifts/search", {
      ...(terms.length ? { "q[]": terms } : {}),
      // Confirmed against the live API: this is how a donor's name ends up
      // on the gift row at all — without it, constituent_name is always
      // empty (LGL doesn't nest a constituent object in the gift response).
      expand: "first_name,last_name,org_name",
      limit,
      offset,
    });
    return paginatedResult(list.items, shapeGift, verbose, list);
  }),
);

// --- run ---------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
