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
import { shapeConstituent, shapeGift, shapeLookup, truncationNote } from "./shape.js";

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
  return textResult({
    results: items.map((item) => shapeFn(item, { verbose })),
    ...(truncationNote(meta) ? { note: truncationNote(meta) } : {}),
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
      const items = await getCachedLookup(path);
      return textResult({ results: items.map((item) => shapeLookup(item, { verbose })) });
    }),
  );
}

// --- constituents --------------------------------------------------------

server.registerTool(
  "search_constituents",
  {
    title: "search_constituents",
    description:
      "Search LGL constituents by name or email. Returns a compact summary " +
      "per match (name, email, phone, city/state, giving dates and lifetime " +
      "total) — pass verbose:true for the full record.",
    inputSchema: {
      query: z.string().min(1).describe("Name, email, or other search text."),
      verbose: verboseParam,
      ...paginationParams,
    },
  },
  safe(async ({ query, verbose, limit, offset }) => {
    // NOTE: LGL's documented syntax (q[]=) and the community MCP server's
    // syntax (search=) disagree and neither is confirmed against a live
    // account yet. Try the documented q[] form first; the spike in the
    // project plan will settle this and this fallback can be simplified
    // once it does.
    let list;
    try {
      list = await getList("/constituents/search", { "q[]": query, limit, offset });
    } catch (err) {
      if (err instanceof LglError && err.status === 422) {
        list = await getList("/constituents/search", { search: query, limit, offset });
      } else {
        throw err;
      }
    }
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
    return textResult(shapeConstituent(raw, { verbose }));
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

server.registerTool(
  "search_gifts",
  {
    title: "search_gifts",
    description:
      "Search gifts across all constituents by date range, amount, or fund. " +
      "Useful for totals and reconciliation questions (e.g. 'gifts in 2025').",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe("Free-text search term, if applicable."),
      from_date: z.string().optional().describe("YYYY-MM-DD, inclusive."),
      to_date: z.string().optional().describe("YYYY-MM-DD, inclusive."),
      fund_id: z.union([z.string(), z.number()]).optional(),
      verbose: verboseParam,
      ...paginationParams,
    },
  },
  safe(async ({ query, from_date, to_date, fund_id, verbose, limit, offset }) => {
    const list = await getList("/gifts/search", {
      "q[]": query,
      from_date,
      to_date,
      fund_id,
      limit,
      offset,
    });
    return paginatedResult(list.items, shapeGift, verbose, list);
  }),
);

// --- run ---------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
