// HTTP client for the Little Green Light REST API.
//
// READ-ONLY BY CONSTRUCTION: request() hardcodes method GET and there is no
// code path here that issues POST/PATCH/PUT/DELETE. Keep it that way — the
// safety guarantee of this server rests on this file.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE_URL = "https://api.littlegreenlight.com/api/v1";

// LGL allows 300 calls per 5-minute window.
const RATE_LIMIT = 300;
const RATE_WINDOW_MS = 5 * 60 * 1000;

const MAX_RETRIES = 4;

/** Thrown for conditions worth showing the user verbatim. */
export class LglError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = "LglError";
    this.status = status;
  }
}

// --- credentials -----------------------------------------------------------

// Resolution order: env var, then ~/.config/lgl-mcp/env, then macOS Keychain.
// The key is never logged or included in error messages.
function loadApiKey() {
  if (process.env.LGL_API_KEY?.trim()) return process.env.LGL_API_KEY.trim();

  const envPath = join(homedir(), ".config", "lgl-mcp", "env");
  try {
    const contents = readFileSync(envPath, "utf8");
    for (const line of contents.split("\n")) {
      const match = line.match(/^\s*(?:export\s+)?LGL_API_KEY\s*=\s*(.*)$/);
      if (match) {
        const value = match[1].trim().replace(/^["']|["']$/g, "");
        if (value) return value;
      }
    }
  } catch {
    // Fall through to Keychain.
  }

  try {
    const value = execFileSync(
      "security",
      ["find-generic-password", "-w", "-s", "lgl-api-key"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (value) return value;
  } catch {
    // Fall through to the error below.
  }

  throw new LglError(
    "No LGL API key found. Set it in ~/.config/lgl-mcp/env as " +
      "LGL_API_KEY=... (chmod 600), or add a Keychain item named 'lgl-api-key'. " +
      "Get the key from LGL: Settings > Integration Settings > LGL API.",
  );
}

let cachedKey = null;
function apiKey() {
  if (!cachedKey) cachedKey = loadApiKey();
  return cachedKey;
}

// --- rate limiting ---------------------------------------------------------

// Sliding window over call timestamps. A single broad question can fan out to
// dozens of calls, so throttling here beats surfacing 429s to the model.
const callTimes = [];

async function throttle() {
  for (;;) {
    const cutoff = Date.now() - RATE_WINDOW_MS;
    while (callTimes.length && callTimes[0] < cutoff) callTimes.shift();
    if (callTimes.length < RATE_LIMIT) {
      callTimes.push(Date.now());
      return;
    }
    const waitMs = callTimes[0] - cutoff + 50;
    await sleep(waitMs);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- requests --------------------------------------------------------------

function buildUrl(path, params = {}) {
  const url = new URL(BASE_URL + path);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    // LGL search takes repeated q[] parameters.
    if (Array.isArray(value)) {
      for (const entry of value) url.searchParams.append(key, String(entry));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function describeStatus(status, path) {
  switch (status) {
    case 401:
      return "LGL returned 401 Unauthorized — the API key is missing, wrong, or revoked.";
    case 403:
      return "LGL returned 403 Forbidden — the key lacks access to this resource.";
    case 404:
      return `LGL returned 404 Not Found for ${path}.`;
    case 422:
      return `LGL returned 422 — the query parameters for ${path} were rejected.`;
    default:
      return `LGL returned HTTP ${status} for ${path}.`;
  }
}

/**
 * Issue a GET against the LGL API. The only request function in this module.
 */
export async function request(path, params = {}) {
  const url = buildUrl(path, params);

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await throttle();

    // Resolve the key outside the network try/catch below, so a missing
    // or misconfigured key surfaces as its own clear error rather than
    // being mislabeled as a network failure.
    const key = apiKey();

    let response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
        },
      });
    } catch (cause) {
      // Network-level failure: worth retrying.
      lastError = new LglError(`Could not reach the LGL API: ${cause.message}`);
      await backoff(attempt);
      continue;
    }

    if (response.ok) {
      try {
        return await response.json();
      } catch {
        throw new LglError(`LGL returned a non-JSON response for ${path}.`);
      }
    }

    // Retry on throttling and transient server errors; fail fast otherwise.
    if (response.status === 429 || response.status >= 500) {
      lastError = new LglError(describeStatus(response.status, path), {
        status: response.status,
      });
      const retryAfter = Number(response.headers.get("retry-after"));
      await (Number.isFinite(retryAfter) && retryAfter > 0
        ? sleep(retryAfter * 1000)
        : backoff(attempt));
      continue;
    }

    throw new LglError(describeStatus(response.status, path), {
      status: response.status,
    });
  }

  throw lastError ??
    new LglError(`LGL request to ${path} failed after ${MAX_RETRIES + 1} attempts.`);
}

function backoff(attempt) {
  const base = Math.min(1000 * 2 ** attempt, 8000);
  return sleep(base + Math.random() * 250); // jitter
}

// --- pagination ------------------------------------------------------------

/**
 * Normalize an LGL list response.
 *
 * LGL's envelope field names vary a little across endpoints, so read
 * defensively rather than assuming one shape.
 */
export function normalizeList(payload, { limit, offset }) {
  const items = Array.isArray(payload)
    ? payload
    : payload?.items ?? payload?.results ?? [];

  const total = Number(
    payload?.total_items ?? payload?.total ?? payload?.count ?? items.length,
  );

  return {
    items,
    total: Number.isFinite(total) ? total : items.length,
    limit,
    offset,
  };
}

/** GET a list endpoint with pagination applied. */
export async function getList(path, { limit = 25, offset = 0, ...params } = {}) {
  const payload = await request(path, { ...params, limit, offset });
  return normalizeList(payload, { limit, offset });
}

// Safety cap so a single get_constituent cannot walk an unbounded gift list.
// 40 pages × 250 = 10,000 gifts; MCF is nowhere near this. If hit, callers
// still get a truncated flag rather than a silently partial lifetime total.
const ALL_LIST_PAGE_SIZE = 250;
const ALL_LIST_MAX_PAGES = 40;

/**
 * Page a list endpoint to completion (or until ALL_LIST_MAX_PAGES).
 * Used for get_constituent giving totals so lifetime_amount is exact.
 */
export async function getAllList(path, params = {}) {
  const items = [];
  let offset = 0;
  let total = 0;
  for (let page = 0; page < ALL_LIST_MAX_PAGES; page++) {
    const result = await getList(path, {
      ...params,
      limit: ALL_LIST_PAGE_SIZE,
      offset,
    });
    total = result.total;
    items.push(...result.items);
    if (result.items.length === 0 || items.length >= total) {
      return { items, total, truncated: items.length < total };
    }
    offset += result.items.length;
  }
  return { items, total, truncated: items.length < total };
}

// --- small cached lookups --------------------------------------------------

// Funds, appeals, gift types and categories are small and change rarely.
// Cache for the process lifetime so repeated questions don't burn rate limit.
const lookupCache = new Map();

export async function getCachedLookup(path) {
  if (lookupCache.has(path)) return lookupCache.get(path);
  // These lists are short; ask for a generous page rather than paging. If an
  // account ever exceeds this, say so rather than silently dropping items —
  // callers can check .truncated.
  const { items, total } = await getList(path, { limit: 250 });
  const result = { items, total, truncated: total > items.length };
  lookupCache.set(path, result);
  return result;
}

export const __testing = { normalizeList, buildUrl, describeStatus };
