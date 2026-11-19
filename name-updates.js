// The only write transport in this project: one name-only PATCH to an
// existing constituent. No generic write method, create, delete, or retries.
import { createHash, randomBytes } from "node:crypto";
import { request, throttle, authenticatedHeaders, LglError } from "./lgl.js";

export const NAME_FIELDS = Object.freeze([
  "prefix", "first_name", "middle_name", "last_name", "suffix",
  "spouse_name", "org_name", "addressee",
]);
const NAME_SET = new Set(NAME_FIELDS);
const DERIVED_FIELDS = new Set(["updated_at", "sort_name"]);

function fail(message) { throw new LglError(message); }

function constituentId(value) {
  const text = String(value);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) {
    fail("A positive, exact LGL constituent ID is required.");
  }
  return Number(text);
}

function validateChanges(changes, { trim = true } = {}) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(changes))) {
    fail("changes must be an object containing explicit name fields.");
  }
  const result = {};
  for (const [field, value] of Object.entries(changes)) {
    if (!NAME_SET.has(field)) fail(`Field '${field}' is outside the permitted name fields.`);
    if (typeof value !== "string" || value.length > 250 || /[\u0000-\u001f\u007f]/.test(value)) {
      fail(`Field '${field}' must be text of at most 250 characters, without control characters.`);
    }
    result[field] = trim ? value.trim() : value;
  }
  if (!Object.keys(result).length) fail("Provide at least one name field.");
  return result;
}

function namesOf(record) {
  return Object.fromEntries(NAME_FIELDS.map(field => {
    const value = record[field];
    if (value != null && typeof value !== "string") fail("LGL returned an unexpected name-field type.");
    return [field, value ?? ""];
  }));
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

function identityOf(record) {
  return {
    id: record.id,
    is_org: record.is_org,
    name: record.is_org ? record.org_name :
      [record.first_name, record.middle_name, record.last_name].filter(Boolean).join(" "),
    addressee: record.addressee ?? "",
  };
}

function assertRecord(record, id) {
  if (!record || record.id !== id || typeof record.is_org !== "boolean") {
    fail("LGL returned a different or incomplete constituent. No update was sent.");
  }
}

/** Internal, fixed-endpoint transport; exported for offline safety tests. */
export async function patchConstituentName(idValue, payload) {
  const id = constituentId(idValue);
  const body = validateChanges(payload, { trim: false });
  await throttle();
  const headers = { ...authenticatedHeaders(), "Content-Type": "application/json" };
  let response;
  try {
    response = await fetch(`https://api.littlegreenlight.com/api/v1/constituents/${id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
  } catch {
    fail("The name update outcome is unknown after a transport failure. Re-read the constituent before preparing another update; this request was not retried.");
  }
  if (!response.ok) {
    const unknown = response.status >= 500;
    throw new LglError(
      `LGL returned HTTP ${response.status} for the name-only update. ` +
      (unknown ? "The outcome is unknown; re-read the constituent before retrying. " : "") +
      "No retry or broader payload was sent.",
      { status: response.status },
    );
  }
}

/** Each service owns one-use previews and per-constituent write locks. */
export function createNameUpdateService({ read = request, patch = patchConstituentName } = {}) {
  const plans = new Map();
  const busy = new Set();

  async function preview({ id: idValue, changes: input }) {
    const id = constituentId(idValue);
    const changes = validateChanges(input);
    const record = await read(`/constituents/${id}`);
    assertRecord(record, id);
    if (Object.keys(changes).some(field => !Object.hasOwn(record, field))) {
      fail("LGL did not return every requested name field. Its existing value cannot be previewed safely; no update was sent.");
    }
    const before = namesOf(record);

    if (!record.is_org && Object.hasOwn(changes, "org_name")) {
      fail("For an individual, org_name is their employer, not their prospect name. It cannot be changed by this tool.");
    }
    if (record.is_org && Object.keys(changes).some(field => !["org_name", "addressee"].includes(field))) {
      fail("An organization's prospect name can change only through org_name or addressee. Contact-person names are outside this tool's scope.");
    }
    if (Object.hasOwn(changes, "spouse_name")) {
      if (!Array.isArray(record.relationships)) {
        fail("LGL did not return relationships, so the spouse field cannot safely be edited. Review the linked records first, or change only the addressee.");
      }
      if (record.relationships.some(r => /spouse|partner/i.test(r?.name ?? ""))) {
        fail("The spouse name comes from a linked constituent. Update that person's own name separately, or change only this record's addressee.");
      }
    }

    const after = { ...before, ...changes };
    if (record.is_org ? !after.org_name.trim() : ![after.first_name, after.last_name].some(n => n.trim())) {
      fail("The update would leave the prospect without a name.");
    }
    const changed = Object.fromEntries(Object.entries(changes).filter(([k, v]) => v !== before[k]));
    const diff = Object.entries(changed).map(([field, after]) => ({ field, before: before[field], after }));
    if (!diff.length) return { status: "unchanged", constituent: identityOf(record), changes: [] };

    // PATCH only the requested differences. If LGL requires additional fields,
    // surface that rejection rather than resending unrelated donor data.
    const payload = { ...changed };
    const token = randomBytes(24).toString("hex");
    // Bound memory without aging or silently evicting an existing preview.
    if (plans.size >= 100) fail("Too many unused previews in this server session. Restart the MCP server to clear them.");
    plans.set(token, { id, fingerprint: fingerprint(record), payload, after, diff });
    return {
      status: "preview",
      constituent: identityOf(record),
      changes: diff,
      confirmation_token: token,
      instruction: "Show these exact changes to the user and obtain approval before applying. A preview token is not approval. The token is valid only in this MCP server session.",
    };
  }

  async function apply({ confirmation_token: token, confirmed }) {
    if (confirmed !== true) fail("Explicit approval of the preview is required before applying.");
    const plan = plans.get(token);
    if (!plan) fail("Unknown or already-used preview token. Prepare a fresh preview.");
    if (busy.has(plan.id)) fail("Another name update for this constituent is running. No update was sent.");
    busy.add(plan.id);
    plans.delete(token);
    try {
      const current = await read(`/constituents/${plan.id}`);
      assertRecord(current, plan.id);
      if (fingerprint(current) !== plan.fingerprint) {
        fail("The constituent changed since the preview. No update was sent. Prepare a fresh preview for review.");
      }
      await patch(plan.id, plan.payload);
      let saved;
      let actual;
      try {
        saved = await read(`/constituents/${plan.id}`);
        if (!saved || saved.id !== plan.id || typeof saved.is_org !== "boolean") {
          throw new Error("Incomplete verification record");
        }
        actual = namesOf(saved);
      }
      catch { return { status: "verification_unavailable", id: plan.id, verified: false,
        message: "The update was sent, but a complete saved record could not be read. Do not repeat the write; inspect the constituent first." }; }
      const mismatched = NAME_FIELDS.filter(field => actual[field] !== plan.after[field]);
      const unexpected = [...new Set([...Object.keys(current), ...Object.keys(saved)])]
        .filter(field => !NAME_SET.has(field) && !DERIVED_FIELDS.has(field))
        .filter(field => encode(current[field]) !== encode(saved[field]));
      const verified = !mismatched.length && !unexpected.length;
      return {
        status: verified ? "updated" : "verification_failed",
        id: plan.id,
        verified,
        changes: plan.diff,
        ...(mismatched.length ? { mismatched_name_fields: mismatched } : {}),
        ...(unexpected.length ? { unexpected_changed_fields: unexpected } : {}),
        ...(!verified ? { message: "The write was sent, but verification did not pass. No retry or automatic rollback was attempted." } : {}),
      };
    } finally { busy.delete(plan.id); }
  }

  return { preview, apply };
}

export const nameUpdates = createNameUpdateService();
