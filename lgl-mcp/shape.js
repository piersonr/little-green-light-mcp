// Response trimming.
//
// LGL's raw JSON objects are large and mostly irrelevant to any one
// question — returning them as-is floods context and makes multi-step
// questions expensive. Each shape* function maps to a compact view; pass
// verbose:true (exposed as a tool parameter) to get the untouched object
// back when it's genuinely wanted.
//
// Field names below are confirmed against a live account (2026-08-18) by
// inspecting raw responses, not guessed. pick() still tries a couple of
// candidates per field as cheap defense against LGL varying field names
// across endpoints (e.g. gift_categories uses display_name where funds and
// appeals use name).

/** Return the first defined, non-null value found at any of the given keys. */
function pick(obj, ...keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function fullName(obj) {
  const direct = pick(obj, "name", "full_name", "display_name", "sort_name");
  if (direct) return direct;
  const first = pick(obj, "first_name", "firstname");
  const last = pick(obj, "last_name", "lastname");
  const org = pick(obj, "organization_name", "org_name");
  if (org) return org;
  if (first || last) return [first, last].filter(Boolean).join(" ");
  return undefined;
}

function primaryEmail(obj) {
  const direct = pick(obj, "email", "primary_email");
  if (direct) return direct;
  const list = obj?.email_addresses ?? obj?.emails;
  if (Array.isArray(list) && list.length) {
    const preferred = list.find((e) => e?.is_preferred ?? e?.primary);
    return pick(preferred ?? list[0], "address", "email", "value");
  }
  return undefined;
}

function primaryPhone(obj) {
  const direct = pick(obj, "phone", "primary_phone");
  if (direct) return direct;
  const list = obj?.phone_numbers ?? obj?.phones;
  if (Array.isArray(list) && list.length) {
    const preferred = list.find((p) => p?.is_preferred ?? p?.primary);
    return pick(preferred ?? list[0], "number", "phone", "value");
  }
  return undefined;
}

function primaryLocation(obj) {
  const direct = { city: pick(obj, "city"), state: pick(obj, "state", "state_code") };
  if (direct.city || direct.state) return direct;
  // Confirmed field name: street_addresses (not "addresses"). Note: in
  // practice this account often has the full address jammed into the
  // free-text "street" field with city/state left null — that's a data
  // quality fact about the account, not a bug here, so undefined is a
  // legitimate result.
  const list = obj?.street_addresses ?? obj?.addresses;
  if (Array.isArray(list) && list.length) {
    const preferred = list.find((a) => a?.is_preferred ?? a?.primary) ?? list[0];
    return {
      city: pick(preferred, "city"),
      state: pick(preferred, "state", "state_code"),
    };
  }
  return { city: undefined, state: undefined };
}

// LGL's constituent object does not include any pre-aggregated giving
// totals or first/last gift dates (confirmed by inspecting the full raw
// object) — giving info has to be computed from that constituent's own
// gifts. `giving` is optional and supplied by the caller (get_constituent
// fetches it separately); shapeConstituent stays a pure mapping otherwise.
export function shapeConstituent(raw, { verbose = false, giving } = {}) {
  if (verbose) return raw;
  const { city, state } = primaryLocation(raw);
  return {
    id: pick(raw, "id", "constituent_id"),
    name: fullName(raw),
    email: primaryEmail(raw),
    phone: primaryPhone(raw),
    city,
    state,
    first_gift_date: giving?.firstGiftDate,
    last_gift_date: giving?.lastGiftDate,
    lifetime_amount: giving?.lifetimeAmount,
    ...(giving?.truncated
      ? { giving_note: `Totals computed from the first ${giving.sampledCount} of ${giving.totalCount} gifts on file.` }
      : {}),
  };
}

/** Reduce a page of raw gifts into the summary shapeConstituent expects. */
export function summarizeGiving(gifts, { totalCount, sampledCount } = {}) {
  if (!gifts.length) return undefined;
  const dates = gifts.map((g) => pick(g, "received_date", "gift_date", "date")).filter(Boolean);
  const amounts = gifts.map((g) => Number(pick(g, "received_amount", "amount"))).filter(Number.isFinite);
  return {
    firstGiftDate: dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : undefined,
    lastGiftDate: dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : undefined,
    lifetimeAmount: amounts.length ? Math.round(amounts.reduce((a, b) => a + b, 0) * 100) / 100 : undefined,
    truncated: totalCount !== undefined && sampledCount !== undefined && sampledCount < totalCount,
    totalCount,
    sampledCount,
  };
}

export function shapeGift(raw, { verbose = false } = {}) {
  if (verbose) return raw;
  return {
    id: pick(raw, "id", "gift_id"),
    constituent_id: pick(raw, "constituent_id"),
    // Only populated when the caller requested expand=first_name,last_name,
    // org_name — LGL returns those flat on the gift object, not nested
    // (confirmed against the /gifts/search expand param).
    constituent_name: fullName(raw) ?? fullName(raw?.constituent ?? {}),
    date: pick(raw, "received_date", "gift_date", "date"),
    amount: pick(raw, "received_amount", "amount"),
    fund: pick(raw, "fund_name") ?? raw?.fund?.name,
    appeal: pick(raw, "appeal_name") ?? raw?.appeal?.name,
    gift_type: pick(raw, "gift_type_name") ?? raw?.gift_type?.name,
    external_id: pick(raw, "external_id"),
  };
}

export function shapeLookup(raw, { verbose = false } = {}) {
  if (verbose) return raw;
  // gift_categories uses display_name; funds/appeals/gift_types use name.
  return { id: pick(raw, "id"), name: pick(raw, "name", "display_name", "title") };
}

/**
 * Build a short, honest note when a list response is capped — so the model
 * doesn't state conclusions as if it saw everything.
 */
export function truncationNote({ total, returned, limit, offset = 0 }) {
  if (total === undefined || returned === undefined) return undefined;
  const seenSoFar = offset + returned;
  if (seenSoFar >= total) return undefined;
  return `Showing ${returned} of ${total} total matches (offset ${offset}, limit ${limit}). Pass a higher offset to see more.`;
}

export const __testing = { pick, fullName, primaryEmail, primaryPhone, primaryLocation };
