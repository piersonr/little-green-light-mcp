// Street-address edits for one existing constituent, through the same
// preview -> one-use token -> stale check -> single write -> verify pattern as
// name-updates.js.
//
// Endpoints and fields confirmed against LGL's API docs
// (api.littlegreenlight.com/api-docs/static.html, "Street Address
// Management") and a read-only GET of a live record on 2026-11-19:
//   GET   /constituents/{id}/street_addresses   list
//   POST  /constituents/{id}/street_addresses   create one address
//   PATCH /street_addresses/{id}                update one address
//   GET   /types/street_address_types           Home, Work, Other, School
// The inactive flag is `not_current`. DELETE exists in LGL but is deliberately
// not implemented here.
//
// Known LGL behavior (AGENTS.md, October 2026 cleanup):
//  - A PATCH that omits is_preferred and not_current silently flips an
//    inactive address to active AND preferred. Every PATCH here sends both.
//  - Clearing is_preferred makes LGL promote another address on its own. This
//    module never clears is_preferred on a preferred address that has
//    siblings; make another address preferred instead.
import { createHash, randomBytes } from "node:crypto";
import { request, throttle, waitForCapacity, authenticatedHeaders, LglError } from "./lgl.js";
import { constituentLocks } from "./locks.js";

const API = "https://api.littlegreenlight.com/api/v1";

// Writable fields this module may send. LGL also accepts county, country,
// street_type_name and seasonal fields; they are left untouched.
const POST_FIELDS = new Set(["street", "city", "state", "postal_code",
  "street_address_type_id", "is_preferred", "not_current"]);
const PATCH_FIELDS = POST_FIELDS;
// Fields this module manages. Every PATCH re-sends their current values so
// none of them is ever left to LGL's defaults (see the flag quirk above).
const MANAGED_FIELDS = Object.freeze(["street", "city", "state", "postal_code", "street_address_type_id"]);

// Fields LGL derives or that only label others. Verification compares every
// other field on every address, the target included.
const DERIVED_ADDRESS_FIELDS = new Set(["updated_at", "created_at", "zip5", "lat", "lng",
  "verified", "verified_on", "street_type_name", "item_id", "item_type", "parent_id"]);
const DERIVED_PROFILE_FIELDS = new Set(["updated_at", "sort_name", "street_addresses"]);

export const US_STATES = Object.freeze([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN",
  "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH",
  "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT",
  "VT", "VA", "WA", "WV", "WI", "WY", "PR", "VI", "GU", "AS", "MP", "AA", "AE", "AP",
]);
const STATE_SET = new Set(US_STATES);
const STATE_NAMES = new Set(["alabama", "alaska", "arizona", "arkansas", "california", "colorado",
  "connecticut", "delaware", "district of columbia", "florida", "georgia", "hawaii", "idaho", "illinois",
  "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan",
  "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey",
  "new mexico", "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon",
  "pennsylvania", "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah",
  "vermont", "virginia", "washington", "west virginia", "wisconsin", "wyoming", "puerto rico"]);
const ZIP_RE = /^\d{5}(-\d{4})?$/;
export const ACTIONS = Object.freeze(["add", "update", "mark_inactive"]);
export const ADDRESS_TYPES = Object.freeze(["Home", "Work", "Other", "School"]);

function fail(message) { throw new LglError(message); }

function exactId(value, label) {
  const text = String(value);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) {
    fail(`A positive, exact LGL ${label} ID is required.`);
  }
  return Number(text);
}

function text(field, value, { max = 250, multiline = false } = {}) {
  if (typeof value !== "string") fail(`${field} must be text.`);
  const trimmed = value.trim();
  const control = multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (trimmed.length > max || control.test(trimmed)) {
    fail(`${field} must be at most ${max} characters, without control characters.`);
  }
  return trimmed;
}

// Account convention: never a single-line address. Flags a street whose last
// line ends in ", <state>" (optionally with a ZIP), ", <ZIP>", a full state
// name with a ZIP, or ", <the city being entered>".
function looksCombined(street, city) {
  const last = street.split("\n").pop().trim();
  const parts = last.split(",").map(part => part.trim());
  if (parts.length < 2) {
    // No comma: only a state code or name directly before a ZIP gives it away
    // ("1 A St Moraga CA 94556"); "PO Box 94556" and "Apt B 94556" pass.
    const m = last.match(/^(.*\S)\s+\d{5}(-\d{4})?$/);
    if (!m) return false;
    const before = m[1].replace(/\.$/, "").toLowerCase();
    const word = before.split(/\s+/).pop();
    return (word.length === 2 && STATE_SET.has(word.toUpperCase())) ||
      [...STATE_NAMES].some(name => before.endsWith(` ${name}`));
  }
  const tail = parts.at(-1);
  // "1200 Maryland Ave, NE": a quadrant straight after the street, not a
  // state after a city ("1 Main St, Lincoln, NE" has a city segment first).
  if (parts.length === 2 && /^(NE|NW|SE|SW)$/i.test(tail)) return false;
  if (/^\d{5}(-\d{4})?$/.test(tail)) return true;
  // Drop a trailing ZIP and period, then look for a state code or a whole
  // state name at the end: ", CA", ", Moraga CA 94556", ", Albany New York".
  const hasZip = /\d{5}(-\d{4})?$/.test(tail);
  const kept = tail.replace(/\s*\d{5}(-\d{4})?$/, "").replace(/\.$/, "").trim();
  const rest = kept.toLowerCase();
  const words = kept.split(/\s+/);
  const code = words.at(-1) ?? "";
  // A bare ", ca" or a code before a ZIP counts in any case; otherwise, after
  // other words ("Ground Fl", "Unit Pa"), only an upper-case code does, so
  // floor and unit lines are not read as states.
  if (code.length === 2 && STATE_SET.has(code.toUpperCase()) &&
      (words.length === 1 || hasZip || code === code.toUpperCase())) return true;
  if (rest === "calif" || rest.endsWith(" calif")) return true;
  for (const name of STATE_NAMES) if (rest === name || rest.endsWith(` ${name}`)) return true;
  const c = typeof city === "string" ? city.trim().toLowerCase() : "";
  // The last comma segment, however it is spaced, naming the city.
  return Boolean(c) && (tail.toLowerCase() === c || rest === c);
}

/** Validate and normalize the address fields supplied by the caller. */
function validateFields(input, { requireAll }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("Address fields are required.");
  const allowed = new Set(["street", "city", "state", "postal_code", "address_type"]);
  for (const key of Object.keys(input)) {
    if (input[key] === undefined) continue;
    if (!allowed.has(key)) fail(`Field '${key}' is outside the permitted address fields.`);
  }
  const out = {};
  if (input.street !== undefined) {
    out.street = text("street", input.street, { multiline: true }).replace(/[ \t]*\n[ \t]*/g, "\n");
    if (!out.street) fail("street cannot be empty.");
    if (looksCombined(out.street, input.city)) {
      fail("street appears to include the city, state or ZIP. Put city, state and postal_code in their own fields.");
    }
  }
  if (input.city !== undefined) {
    out.city = text("city", input.city, { max: 100 });
    if (!out.city) fail("city cannot be empty.");
  }
  if (input.state !== undefined) {
    out.state = text("state", input.state, { max: 30 }).toUpperCase();
    if (!STATE_SET.has(out.state)) fail(`state must be a two-letter US state or territory code; got '${input.state}'.`);
  }
  if (input.postal_code !== undefined) {
    out.postal_code = text("postal_code", input.postal_code, { max: 10 });
    if (!ZIP_RE.test(out.postal_code)) fail("postal_code must be a US ZIP (12345) or ZIP+4 (12345-6789).");
  }
  if (input.address_type !== undefined) {
    const match = ADDRESS_TYPES.find(t => t.toLowerCase() === String(input.address_type).trim().toLowerCase());
    if (!match) fail(`address_type must be one of ${ADDRESS_TYPES.join(", ")}.`);
    out.address_type = match;
  }
  if (requireAll) {
    for (const field of ["street", "city", "state", "postal_code"]) {
      if (out[field] === undefined) fail(`A new address needs ${field}. Street, city, state and postal_code go in their own fields.`);
    }
  }
  return out;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}
const encode = value => JSON.stringify(stable(value));
const fingerprint = value => createHash("sha256").update(encode(value)).digest("hex");
// LGL returns empty text fields as either null or "" (country is "" on some
// records and null on others), so treat the two as equal when comparing.
const norm = value => (value === "" || value === undefined ? null : value);
const same = (a, b) => encode(norm(a)) === encode(norm(b));

/** Compact, display-friendly view of one LGL street address. */
export function shapeAddress(a) {
  return {
    id: a.id,
    street: a.street ?? null,
    city: a.city ?? null,
    state: a.state ?? null,
    postal_code: a.postal_code ?? null,
    country: a.country ?? null,
    address_type: a.street_type_name ?? null,
    address_type_id: a.street_address_type_id ?? null,
    is_preferred: a.is_preferred === true,
    not_current: a.not_current === true,
    ...(a.seasonal ? { seasonal: true, seasonal_from: a.seasonal_from, seasonal_to: a.seasonal_to } : {}),
  };
}

function identityOf(record) {
  return {
    id: record.id,
    is_org: record.is_org,
    name: record.is_org ? record.org_name :
      [record.first_name, record.middle_name, record.last_name].filter(Boolean).join(" "),
  };
}

/** Current values of the managed fields, omitting ones LGL has empty. */
function managedOf(address) {
  return Object.fromEntries(MANAGED_FIELDS.filter(k => address[k] != null && address[k] !== "").map(k => [k, address[k]]));
}

const isUs = a => a.country == null || /^\s*(|us|usa|united states( of america)?)\s*$/i.test(a.country);

// --- read helpers ----------------------------------------------------------

async function readAddresses(read, id) {
  const payload = await read(`/constituents/${id}/street_addresses`, { limit: 100, offset: 0 });
  const items = payload?.items;
  if (!Array.isArray(items)) fail("LGL returned an unexpected street-address list.");
  const total = Number(payload.total_items);
  if (payload.total_items == null || !Number.isFinite(total)) {
    fail("LGL did not say how many street addresses this constituent has, so the list cannot be trusted as complete. No update was prepared.");
  }
  if (total !== items.length) {
    fail("This constituent has more street addresses than one page returns. No update was prepared.");
  }
  for (const a of items) {
    if (!a || !Number.isSafeInteger(a.id) || typeof a.is_preferred !== "boolean" || typeof a.not_current !== "boolean") {
      fail("LGL returned a street address without an id or its preferred/not-current flags. No update was prepared.");
    }
  }
  return [...items].sort((x, y) => x.id - y.id);
}

async function readState(read, id) {
  const record = await read(`/constituents/${id}`);
  if (!record || record.id !== id || typeof record.is_org !== "boolean") {
    fail("LGL returned a different or incomplete constituent. No update was sent.");
  }
  const addresses = await readAddresses(read, id);
  return { record, addresses };
}

// --- fixed write transports ------------------------------------------------

function checkBody(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("Invalid address payload.");
  for (const key of Object.keys(body)) if (!allowed.has(key)) fail(`Field '${key}' is outside the permitted address fields.`);
  if (typeof body.is_preferred !== "boolean" || typeof body.not_current !== "boolean") {
    fail("Every address write must send is_preferred and not_current explicitly.");
  }
}

// How long a write may start after its stale check began. The clock starts
// before the stale-check reads, so a slow or rate-limited read also counts;
// a write that cannot start in time is abandoned rather than sent against a
// state that was read too long ago.
export const WRITE_WINDOW_MS = 10000;

async function send(method, url, body, what, notAfter) {
  if (!Number.isFinite(notAfter)) fail("Every address write needs a deadline from its stale check.");
  await throttle();
  if (Date.now() > notAfter) {
    fail(`The ${what} was not sent: the rate-limit wait outlasted the stale check. Prepare a fresh preview.`);
  }
  const headers = { ...authenticatedHeaders(), "Content-Type": "application/json" };
  let response;
  try {
    response = await fetch(url, { method, headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000), redirect: "error" });
  } catch {
    fail(`The ${what} outcome is unknown after a transport failure. Re-read the constituent's addresses before preparing another update; this request was not retried.`);
  }
  if (!response.ok) {
    const unknown = response.status >= 500;
    throw new LglError(
      `LGL returned HTTP ${response.status} for the ${what}. ` +
      (unknown ? "The outcome is unknown; re-read the addresses before retrying. " : "") +
      "No retry was sent.",
      { status: response.status },
    );
  }
}

/** POST one new address to an existing constituent. Exported for offline tests. */
export async function postStreetAddress(constituentIdValue, body, { notAfter } = {}) {
  const id = exactId(constituentIdValue, "constituent");
  checkBody(body, POST_FIELDS);
  await send("POST", `${API}/constituents/${id}/street_addresses`, body, "address create", notAfter);
}

/** PATCH one existing address. Exported for offline tests. */
export async function patchStreetAddress(addressIdValue, body, { notAfter } = {}) {
  const id = exactId(addressIdValue, "street address");
  checkBody(body, PATCH_FIELDS);
  await send("PATCH", `${API}/street_addresses/${id}`, body, "address update", notAfter);
}

// --- service ----------------------------------------------------------------

export function createAddressUpdateService({
  read = request, post = postStreetAddress, patch = patchStreetAddress, locks = constituentLocks,
  capacity = waitForCapacity,
} = {}) {
  const plans = new Map();
  const busy = locks;

  async function resolveTypeId(name) {
    const payload = await read("/types/street_address_types");
    const match = (payload?.items ?? []).find(t => String(t?.name).toLowerCase() === name.toLowerCase());
    if (!match || !Number.isSafeInteger(match.id)) fail(`LGL has no street address type named '${name}'.`);
    return match.id;
  }

  async function list({ id: idValue }) {
    const id = exactId(idValue, "constituent");
    const addresses = await readAddresses(read, id);
    return { constituent_id: id, addresses: addresses.map(shapeAddress) };
  }

  async function preview(args) {
    const id = exactId(args?.id, "constituent");
    const action = args?.action;
    if (!ACTIONS.includes(action)) fail(`action must be one of ${ACTIONS.join(", ")}.`);
    if (args.make_preferred !== undefined && typeof args.make_preferred !== "boolean") {
      fail("make_preferred must be true or false.");
    }
    const notes = [];
    let fields = {};
    if (action === "add") fields = validateFields(args.address, { requireAll: true });
    if (action === "update") {
      fields = validateFields(args.address ?? {}, { requireAll: false });
      if (!Object.keys(fields).length && args.make_preferred !== true) {
        fail("Provide at least one address field to change, or make_preferred: true.");
      }
    }
    if (action === "mark_inactive" && (args.address !== undefined || args.make_preferred !== undefined)) {
      fail("mark_inactive takes only address_id. Use update to change fields.");
    }
    if (action === "add" && args.address_id !== undefined) fail("add does not take address_id.");
    if (action === "update" && args.make_preferred === false) {
      fail("make_preferred: false is not supported. LGL promotes another address on its own when the flag is cleared; make the intended address preferred instead.");
    }
    const addressId = action === "add" ? null : exactId(args.address_id, "street address");
    // A new address defaults to Home, looked up like any other type.
    const typeName = fields.address_type ?? (action === "add" ? "Home" : undefined);
    const typeId = typeName ? await resolveTypeId(typeName) : undefined;

    const { record, addresses } = await readState(read, id);
    const before = addresses.map(shapeAddress);
    let expected;   // full expected address list after the write (shaped, by id; new = "new")
    let method, payload, target;

    if (action === "add") {
      const dupe = addresses.find(a => !a.not_current &&
        (a.street ?? "").trim().toLowerCase() === fields.street.toLowerCase() &&
        (a.postal_code ?? "").slice(0, 5) === fields.postal_code.slice(0, 5));
      if (dupe) fail(`An active address with the same street and ZIP already exists (id ${dupe.id}). Use update instead.`);
      const hasCurrentPreferred = addresses.some(a => a.is_preferred && !a.not_current);
      const preferred = args.make_preferred ?? !hasCurrentPreferred;
      if (args.make_preferred === undefined && preferred) {
        notes.push("The constituent has no current preferred address, so this one will be preferred.");
      }
      if (!preferred && !hasCurrentPreferred) {
        notes.push("WARNING: the constituent will still have no current preferred address, so mail and acknowledgement letters may not use this one.");
      }
      payload = { street: fields.street, city: fields.city, state: fields.state, postal_code: fields.postal_code,
        street_address_type_id: typeId, is_preferred: preferred, not_current: false };
      method = "post";
      // A new address must come back with nothing set beyond what was sent.
      target = { id: "new", ...payload, street_type_name: typeName,
        country: null, county: null, seasonal: false };
      expected = addresses.map(a => preferred && a.is_preferred ? { ...a, is_preferred: false } : a);
      if (preferred && addresses.some(a => a.is_preferred)) {
        notes.push("Making this address preferred is expected to clear the preferred flag on the current preferred address.");
      }
    } else {
      const current = addresses.find(a => a.id === addressId);
      if (!current) fail(`Address ${addressId} does not belong to constituent ${id}.`);
      if (!isUs(current)) fail("This tool edits US addresses only; that address has a non-US country.");
      if (action === "mark_inactive") {
        if (current.not_current) return { status: "unchanged", constituent: identityOf(record), addresses: before,
          message: "That address is already marked not current." };
        const others = addresses.filter(a => a.id !== addressId);
        if (current.is_preferred && others.length) {
          fail(others.every(a => a.not_current)
            ? `That address is the preferred one, and the constituent's other addresses (${others.map(a => a.id).join(", ")}) are all inactive. LGL would promote one of those inactive addresses on its own. Add the replacement address with make_preferred: true first, then mark this one inactive.`
            : "That address is the preferred one. LGL picks a new preferred address on its own when the flag is cleared. First make the correct current address preferred (update with make_preferred: true, or add with make_preferred: true), then mark this one inactive.");
        }
        payload = { ...managedOf(current), is_preferred: false, not_current: true };
        if (current.is_preferred) notes.push("This is the constituent's only address. It will be left with no preferred, current address.");
      } else {
        if (current.not_current && args.make_preferred === true) {
          fail("That address is marked not current and cannot be made preferred.");
        }
        if (fields.street !== undefined && fields.city === undefined && looksCombined(fields.street, current.city ?? "")) {
          fail("street appears to include the city, state or ZIP. Put city, state and postal_code in their own fields.");
        }
        const changed = {};
        for (const key of ["street", "city", "state", "postal_code"]) {
          if (fields[key] !== undefined && fields[key] !== current[key]) changed[key] = fields[key];
        }
        if (typeId !== undefined && typeId !== current.street_address_type_id) changed.street_address_type_id = typeId;
        const preferred = args.make_preferred === true ? true : current.is_preferred;
        if (!Object.keys(changed).length && preferred === current.is_preferred) {
          return { status: "unchanged", constituent: identityOf(record), addresses: before, message: "No differences from the saved address." };
        }
        payload = { ...managedOf(current), ...changed, is_preferred: preferred, not_current: current.not_current };
        const result = { ...current, ...changed };
        if (!String(result.street ?? "").trim()) fail("The update would leave the address without a street.");
      }
      method = "patch";
      target = { ...current, ...payload,
        ...(fields.address_type !== undefined ? { street_type_name: fields.address_type } : {}) };
      const demote = payload.is_preferred && !current.is_preferred;
      expected = addresses.map(a => a.id === addressId ? target
        : demote && a.is_preferred ? { ...a, is_preferred: false } : a);
      if (demote && addresses.some(a => a.id !== addressId && a.is_preferred)) {
        notes.push("Making this address preferred is expected to clear the preferred flag on the current preferred address.");
      }
    }

    // Every PATCH re-sends the managed fields, so an address must already be in
    // separate street, city, state and postal_code fields before it is written.
    if (method === "patch") {
      const blank = ["city", "state", "postal_code"].filter(key => !String(target[key] ?? "").trim());
      if (blank.length || looksCombined(String(target.street ?? ""), target.city)) {
        fail(`This address is not split into separate fields (${blank.length ? `empty: ${blank.join(", ")}` : "street holds city, state or ZIP text"}). ` +
          "Update it first with street, city, state and postal_code each in its own field" +
          (action === "mark_inactive" ? ", then mark it inactive." : ", in the same update or before this change."));
      }
    }
    const after = (method === "post" ? [...expected, target] : expected).map(shapeAddress);

    if (plans.size >= 100) fail("Too many unused previews in this server session. Restart the MCP server to clear them.");
    const token = randomBytes(24).toString("hex");
    plans.set(token, { id, action, addressId, method, payload,
      fingerprint: fingerprint({ record, addresses }), before: addresses, expected, target });
    return {
      status: "preview",
      constituent: identityOf(record),
      action,
      ...(addressId ? { address_id: addressId } : {}),
      request: { method: method === "post" ? `POST /constituents/${id}/street_addresses` : `PATCH /street_addresses/${addressId}`, body: payload },
      current_addresses: before,
      addresses_after: after,
      ...(notes.length ? { notes } : {}),
      confirmation_token: token,
      instruction: "Show the current and resulting addresses to the user and obtain approval before applying. A preview token is not approval. The token is valid only in this MCP server session.",
    };
  }

  // Compare every non-derived field either side has. `skip` lists fields
  // whose value LGL defaults on create and this module never sets.
  function compareAddress(actual, wanted, skip = []) {
    const keys = [...new Set([...Object.keys(wanted), ...Object.keys(actual)])]
      .filter(k => k !== "id" && !DERIVED_ADDRESS_FIELDS.has(k) && !skip.includes(k));
    // A field the expectation names must be present in the saved address:
    // an omitted field is not evidence that it is empty.
    return keys.filter(k => (Object.hasOwn(wanted, k) && !Object.hasOwn(actual, k)) || !same(actual[k], wanted[k]));
  }

  async function apply({ confirmation_token: token, confirmed } = {}) {
    if (confirmed !== true) fail("Explicit approval of the preview is required before applying.");
    const plan = plans.get(token);
    if (!plan) fail("Unknown or already-used preview token. Prepare a fresh preview.");
    if (busy.has(plan.id)) fail("Another update for this constituent is running. No update was sent.");
    busy.add(plan.id);
    plans.delete(token);
    try {
      // Room for the stale-check reads and the write, so the limiter does not
      // hold the write after the check has passed.
      await capacity(4);
      const notAfter = Date.now() + WRITE_WINDOW_MS;
      const current = await readState(read, plan.id);
      if (fingerprint(current) !== plan.fingerprint) {
        fail("The constituent or its addresses changed since the preview. No update was sent. Prepare a fresh preview for review.");
      }
      if (plan.method === "post") await post(plan.id, plan.payload, { notAfter });
      else await patch(plan.addressId, plan.payload, { notAfter });

      let saved;
      try { saved = await readState(read, plan.id); }
      catch {
        return { status: "verification_unavailable", id: plan.id, verified: false,
          message: "The write was sent, but the saved record and addresses could not be read completely. Do not repeat the write; inspect the constituent first." };
      }

      const problems = [];
      const beforeIds = new Set(plan.before.map(a => a.id));
      const savedById = new Map(saved.addresses.map(a => [a.id, a]));
      let targetSaved;
      if (plan.method === "post") {
        const added = saved.addresses.filter(a => !beforeIds.has(a.id));
        if (added.length !== 1) problems.push({ issue: `expected exactly one new address, found ${added.length}` });
        targetSaved = added.length === 1 ? added[0] : null;
        if (targetSaved) {
          const diff = compareAddress(targetSaved, plan.target, ["seasonal_from", "seasonal_to"]);
          if (diff.length) problems.push({ address_id: targetSaved.id, issue: "new address does not match the preview", fields: diff });
        }
      } else {
        targetSaved = savedById.get(plan.addressId) ?? null;
        if (!targetSaved) problems.push({ address_id: plan.addressId, issue: "address is missing after the update" });
        else {
          const diff = compareAddress(targetSaved, plan.target);
          if (diff.length) problems.push({ address_id: plan.addressId, issue: "saved address does not match the preview", fields: diff });
        }
        const extra = saved.addresses.filter(a => !beforeIds.has(a.id));
        if (extra.length) problems.push({ issue: `unexpected new addresses: ${extra.map(a => a.id).join(", ")}` });
      }
      for (const wanted of plan.expected) {
        if (wanted.id === "new" || (plan.method === "patch" && wanted.id === plan.addressId)) continue;
        const actual = savedById.get(wanted.id);
        if (!actual) { problems.push({ address_id: wanted.id, issue: "other address is missing after the update" }); continue; }
        const diff = compareAddress(actual, wanted);
        if (diff.length) problems.push({ address_id: wanted.id, issue: "other address changed unexpectedly", fields: diff });
      }
      const profileKeys = [...new Set([...Object.keys(current.record), ...Object.keys(saved.record)])]
        .filter(k => !DERIVED_PROFILE_FIELDS.has(k));
      // A field present before the write must still be present: an omitted
      // field is not evidence that it is unchanged.
      const profileChanged = profileKeys.filter(k =>
        (Object.hasOwn(current.record, k) && !Object.hasOwn(saved.record, k)) || !same(current.record[k], saved.record[k]));
      if (profileChanged.length) problems.push({ issue: "constituent profile fields changed unexpectedly", fields: profileChanged });

      const verified = problems.length === 0;
      return {
        status: verified ? "updated" : "verification_failed",
        id: plan.id,
        action: plan.action,
        verified,
        ...(targetSaved ? { address: shapeAddress(targetSaved) } : {}),
        addresses: saved.addresses.map(shapeAddress),
        ...(!verified ? {
          problems,
          message: "VERIFICATION FAILED: the write was sent, but the saved data does not match the preview. No retry or automatic rollback was attempted. Review the listed problems in LGL before doing anything else.",
        } : {}),
      };
    } finally { busy.delete(plan.id); }
  }

  return { list, preview, apply };
}

export const addressUpdates = createAddressUpdateService();
