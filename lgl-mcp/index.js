#!/usr/bin/env node
// Read-only MCP server for the Little Green Light donor CRM.
//
// SAFETY INVARIANT: this file registers eight tools, none of which write to
// LGL. lgl.js only exposes a GET request() function — there is no code path
// anywhere in this project that can create, update, or delete a donor
// record. Any future write path belongs in LGL's own reviewed Integration
// Queue, not here. Verify this mechanically with `npm run audit:readonly`
// before every registration change.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { request, getList, getCachedLookup, LglError } from "./lgl.js";
import { shapeConstituent, shapeGift, shapeLookup, summarizeGiving, truncationNote } from "./shape.js";

const server = new McpServer({
  name: "lgl-mcp",
  version: "0.1.0",
  title: "Little Green Light (read-only)",
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
      "summary per match (name, email, phone, city/state, giving dates and " +
      "lifetime total) — pass verbose:true for the full record.",
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
    description: "Fetch one constituent's full profile by LGL id.",
    inputSchema: {
      id: z.union([z.string(), z.number()]).describe("LGL constituent id."),
      verbose: verboseParam,
    },
  },
  safe(async ({ id, verbose }) => {
    const raw = await request(`/constituents/${id}`);
    if (verbose) return textResult(shapeConstituent(raw, { verbose }));

    // LGL doesn't return giving totals on the constituent object itself —
    // compute them from that constituent's own gift history. Capped at 250
    // (a large page for one person's giving history) so one question can't
    // fan out into unbounded pagination; shapeConstituent reports if capped.
    const giftsPage = await getList(`/constituents/${id}/gifts`, { limit: 250, offset: 0 });
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
