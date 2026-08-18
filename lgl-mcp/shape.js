// Response trimming.
//
// LGL's raw JSON objects are large and mostly irrelevant to any one
// question — returning them as-is floods context and makes multi-step
// questions expensive. Each shape* function maps to a compact view; pass
// verbose:true (exposed as a tool parameter) to get the untouched object
// back when it's genuinely wanted.
//
// NOTE ON FIELD NAMES: LGL's exact JSON field names for constituents/gifts
// are not fully confirmed against the live API yet (see the search-syntax
// spike in the project plan). The pick() helper below tries several
// plausible candidates per field rather than assuming one name, so this
// keeps working once the spike confirms which names the account actually
// returns — but the candidate lists here should be revisited then.

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
  const list = obj?.addresses;
  if (Array.isArray(list) && list.length) {
    const preferred = list.find((a) => a?.is_preferred ?? a?.primary) ?? list[0];
    return {
      city: pick(preferred, "city"),
      state: pick(preferred, "state", "state_code"),
    };
  }
  return { city: undefined, state: undefined };
}

export function shapeConstituent(raw, { verbose = false } = {}) {
  if (verbose) return raw;
  const { city, state } = primaryLocation(raw);
  return {
    id: pick(raw, "id", "constituent_id"),
    name: fullName(raw),
    email: primaryEmail(raw),
    phone: primaryPhone(raw),
    city,
    state,
    first_gift_date: pick(raw, "first_gift_date", "earliest_gift_date"),
    last_gift_date: pick(raw, "last_gift_date", "latest_gift_date"),
    lifetime_amount: pick(
      raw,
      "lifetime_amount",
      "total_giving",
      "lifetime_giving",
    ),
  };
}

export function shapeGift(raw, { verbose = false } = {}) {
  if (verbose) return raw;
  return {
    id: pick(raw, "id", "gift_id"),
    constituent_id: pick(raw, "constituent_id"),
    constituent_name: fullName(raw?.constituent ?? {}) ?? pick(raw, "constituent_name"),
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
  return { id: pick(raw, "id"), name: pick(raw, "name", "title") };
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
