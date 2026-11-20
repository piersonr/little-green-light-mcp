import test from "node:test";
import assert from "node:assert/strict";
import { createAddressUpdateService, postStreetAddress, patchStreetAddress } from "../address-updates.js";

// Never load real credentials or send network traffic in this suite.
process.env.LGL_API_KEY = "offline-test-key";
globalThis.fetch = async () => { throw new Error("Unexpected network call in an offline test"); };

const addr = (id, extra = {}) => ({
  id, item_id: 42, item_type: "Constituent", street: `${id} Old Rd`, city: "Moraga", state: "CA",
  country: null, postal_code: "94556", county: null, street_address_type_id: 1, street_type_name: "Home",
  is_preferred: false, not_current: false, parent_id: null, seasonal_from: "01-01", seasonal_to: "12-31",
  seasonal: false, lat: null, lng: null, zip5: "94556", verified: false, verified_on: null,
  created_at: "c", updated_at: "u", ...extra,
});
const profile = () => ({ id: 42, is_org: false, first_name: "Alex", last_name: "Example",
  addressee: "Alex Example", groups: [{ id: 2 }], email_addresses: [], updated_at: "before" });
const TYPES = { items: [{ id: 1, name: "Home" }, { id: 2, name: "Work" }, { id: 3, name: "Other" }, { id: 4, name: "School" }] };

/**
 * A fake LGL that behaves like the real one on preferred flags: setting
 * is_preferred on one address clears it on the others. `misbehave` lets a
 * test simulate LGL saving something different from what was sent.
 */
function fixture(addresses = [addr(1, { is_preferred: true }), addr(2)], { misbehave = s => s, failWrite, resetOmitted = false } = {}) {
  let state = { record: profile(), addresses: structuredClone(addresses) };
  let nextId = 100;
  const reads = [], writes = [];
  const commit = (changedId, preferred) => {
    if (preferred) state.addresses.forEach(a => { if (a.id !== changedId) a.is_preferred = false; });
    state.record.updated_at = "after";
    state = misbehave(state);
  };
  const service = createAddressUpdateService({
    read: async (path, params) => {
      reads.push(path);
      if (path === "/types/street_address_types") return TYPES;
      if (path === "/constituents/42") return { ...structuredClone(state.record), street_addresses: structuredClone(state.addresses) };
      if (path === "/constituents/42/street_addresses") {
        assert.deepEqual(params, { limit: 100, offset: 0 });
        return { total_items: state.addresses.length, items: structuredClone(state.addresses) };
      }
      throw new Error(`unexpected read ${path}`);
    },
    post: async (id, body) => {
      writes.push({ method: "POST", id, body: structuredClone(body) });
      if (failWrite) throw failWrite;
      const created = addr(nextId++, { ...body, street_type_name: TYPES.items.find(t => t.id === body.street_address_type_id).name });
      state.addresses.push(created);
      commit(created.id, body.is_preferred);
    },
    patch: async (id, body) => {
      writes.push({ method: "PATCH", id, body: structuredClone(body) });
      if (failWrite) throw failWrite;
      const a = state.addresses.find(x => x.id === id);
      if (resetOmitted) {
        for (const field of ["street", "city", "state", "postal_code", "street_address_type_id"]) if (!(field in body)) a[field] = null;
        if (!("is_preferred" in body)) a.is_preferred = true;
        if (!("not_current" in body)) a.not_current = false;
      }
      Object.assign(a, body, { updated_at: "after" });
      if (body.street_address_type_id) a.street_type_name = TYPES.items.find(t => t.id === body.street_address_type_id).name;
      commit(id, body.is_preferred);
    },
  });
  return { ...service, reads, writes, mutate: fn => { fn(state); } };
}
const apply = (service, preview) => service.apply({ confirmation_token: preview.confirmation_token, confirmed: true });
const NEW = { street: "12 Example Way", city: "Moraga", state: "ca", postal_code: "94556-1234" };

test("list returns each address with id, fields and flags", async () => {
  const service = fixture([addr(1, { is_preferred: true }), addr(2, { not_current: true, street_type_name: "Work", street_address_type_id: 2 })]);
  const result = await service.list({ id: 42 });
  assert.equal(result.addresses.length, 2);
  assert.deepEqual(result.addresses[1], { id: 2, street: "2 Old Rd", city: "Moraga", state: "CA", postal_code: "94556",
    country: null, address_type: "Work", address_type_id: 2, is_preferred: false, not_current: true });
  assert.equal(service.writes.length, 0);
});

test("add: preview writes nothing, apply POSTs once and verifies, demoting the old preferred", async () => {
  const service = fixture();
  const preview = await service.preview({ id: 42, action: "add", address: NEW, make_preferred: true });
  assert.equal(preview.status, "preview");
  assert.equal(service.writes.length, 0);
  assert.match(preview.confirmation_token, /^[a-f0-9]{48}$/);
  assert.match(preview.instruction, /token is not approval/);
  assert.equal(preview.current_addresses.length, 2);
  assert.equal(preview.addresses_after.length, 3);
  assert.equal(preview.addresses_after.find(a => a.id === 1).is_preferred, false);
  assert.deepEqual(preview.request.body, { street: "12 Example Way", city: "Moraga", state: "CA",
    postal_code: "94556-1234", street_address_type_id: 1, is_preferred: true, not_current: false });

  const result = await apply(service, preview);
  assert.equal(result.status, "updated", JSON.stringify(result.problems));
  assert.equal(result.verified, true);
  assert.equal(result.address.street, "12 Example Way");
  assert.deepEqual(service.writes.map(w => [w.method, w.id]), [["POST", 42]]);
});

test("update: PATCHes only changed fields plus both flags, and verifies", async () => {
  const service = fixture();
  const preview = await service.preview({ id: 42, action: "update", address_id: 2,
    address: { city: "Moraga", postal_code: "94556-0001", address_type: "Work" } });
  assert.deepEqual(preview.request.body, { street: "2 Old Rd", city: "Moraga", state: "CA",
    postal_code: "94556-0001", street_address_type_id: 2, is_preferred: false, not_current: false });
  assert.equal(preview.addresses_after.find(a => a.id === 2).address_type, "Work");
  const result = await apply(service, preview);
  assert.equal(result.verified, true, JSON.stringify(result.problems));
  assert.deepEqual(service.writes, [{ method: "PATCH", id: 2, body: preview.request.body }]);
});

test("update: make_preferred moves the preferred flag and is verified", async () => {
  const service = fixture();
  const preview = await service.preview({ id: 42, action: "update", address_id: 2, make_preferred: true });
  assert.deepEqual(preview.request.body, { street: "2 Old Rd", city: "Moraga", state: "CA",
    postal_code: "94556", street_address_type_id: 1, is_preferred: true, not_current: false });
  assert.equal(preview.addresses_after.find(a => a.id === 2).address_type, "Home");
  assert.equal((await apply(service, preview)).verified, true);
});

test("mark_inactive: sends not_current with both flags explicit and verifies", async () => {
  const service = fixture();
  const preview = await service.preview({ id: 42, action: "mark_inactive", address_id: 2 });
  assert.deepEqual(preview.request.body, { street: "2 Old Rd", city: "Moraga", state: "CA",
    postal_code: "94556", street_address_type_id: 1, is_preferred: false, not_current: true });
  assert.equal(preview.addresses_after.find(a => a.id === 2).not_current, true);
  assert.equal(preview.addresses_after.find(a => a.id === 2).address_type, "Home");
  const result = await apply(service, preview);
  assert.equal(result.verified, true, JSON.stringify(result.problems));
  assert.equal(result.address.not_current, true);
  assert.equal(service.writes.length, 1);
});

test("mark_inactive refuses the preferred address while siblings exist; allows a sole address", async () => {
  const service = fixture();
  await assert.rejects(service.preview({ id: 42, action: "mark_inactive", address_id: 1 }), /preferred one/);
  const sole = fixture([addr(1, { is_preferred: true })]);
  const preview = await sole.preview({ id: 42, action: "mark_inactive", address_id: 1 });
  assert.match(preview.notes.join(" "), /only address/);
  assert.equal((await apply(sole, preview)).verified, true);
});

test("already-inactive or unchanged requests return unchanged without a token", async () => {
  const service = fixture([addr(1, { is_preferred: true }), addr(2, { not_current: true })]);
  const inactive = await service.preview({ id: 42, action: "mark_inactive", address_id: 2 });
  assert.equal(inactive.status, "unchanged");
  assert.equal(inactive.confirmation_token, undefined);
  const same = await service.preview({ id: 42, action: "update", address_id: 1, address: { city: "Moraga" } });
  assert.equal(same.status, "unchanged");
  assert.equal(service.writes.length, 0);
});

test("bad input is rejected before any read or write", async () => {
  const service = fixture();
  const bad = [
    { id: 0, action: "add", address: NEW },
    { id: "42/x", action: "add", address: NEW },
    { id: 42, action: "delete", address_id: 1 },
    { id: 42, action: "add", address: { ...NEW, street: "   " } },
    { id: 42, action: "add", address: { ...NEW, state: "California" } },
    { id: 42, action: "add", address: { ...NEW, state: "ZZ" } },
    { id: 42, action: "add", address: { ...NEW, postal_code: "9455" } },
    { id: 42, action: "add", address: { ...NEW, postal_code: "94556-12" } },
    { id: 42, action: "add", address: { ...NEW, postal_code: "ABCDE" } },
    { id: 42, action: "add", address: { street: "1 A St", city: "Moraga", state: "CA" } },
    { id: 42, action: "add", address: { ...NEW, street: "1 A St, Moraga, CA 94556" } },
    { id: 42, action: "add", address: { ...NEW, street: "1 A St, Moraga, CA" } },
    { id: 42, action: "add", address: { ...NEW, street: "1 A St, Moraga" } },
    { id: 42, action: "add", address: { ...NEW, street: "1 A St, California 94556" } },
    { id: 42, action: "add", address: { ...NEW, street: "1 A St\nMoraga, CA. 94556" } },
    { id: 42, action: "add", address: { ...NEW, street: "1 A St, 94556" } },
    { id: 42, action: "add", address: { ...NEW, street: "1 A St, Moraga CA" } },
    { id: 42, action: "add", address: { ...NEW, street: "1 A St, Moraga, California" } },
    { id: 42, action: "add", address: { ...NEW, street: "1 A St, Albany New York" } },
    { id: 42, action: "add", address: { ...NEW, street: "1 A St, North Carolina 27601" } },
    { id: 42, action: "add", address: { ...NEW, street: "1 A St, Lincoln, NE" } },
    { id: 42, action: "add", address: { ...NEW, street: "1 A St, Lincoln, NE 68508" } },
    { id: 42, action: "add", address: { ...NEW, street: "1 A St, New York 10001" } },
    { id: 42, action: "add", address: { ...NEW, street: "1 A St, Washington, District of Columbia" } },
    { id: 42, action: "add", address: { ...NEW, street: "1 A St, Moraga, Calif." } },
    { id: 42, action: "add", address: { ...NEW, street: "1 A St, Moraga, CA94556" } },
    { id: 42, action: "add", address: { ...NEW, street: "1 A St, Moraga ca 94556" } },
    { id: 42, action: "add", address: { ...NEW, street: "1 A St Moraga CA 94556" } },
    { id: 42, action: "add", address: { ...NEW, street: "1 A St Albany New York 12207" } },
    { id: 42, action: "add", address: { ...NEW, country: "US" } },
    { id: 42, action: "add", address: { ...NEW, address_type: "Vacation" } },
    { id: 42, action: "add", address: { ...NEW, street: "1 A St\u0000" } },
    { id: 42, action: "add", address: NEW, address_id: 1 },
    { id: 42, action: "update", address: { city: "Moraga" } },
    { id: 42, action: "update", address_id: 1 },
    { id: 42, action: "update", address_id: 1, address: { street: "" } },
    { id: 42, action: "update", address_id: 1, make_preferred: false },
    { id: 42, action: "mark_inactive", address_id: 2, address: { city: "X" } },
    { id: 42, action: "add", address: NEW, make_preferred: "yes" },
  ];
  for (const args of bad) await assert.rejects(service.preview(args), undefined, JSON.stringify(args));
  assert.deepEqual(service.reads, []);
  assert.equal(service.writes.length, 0);
});

test("record-level checks: foreign address id, duplicates, non-US, inactive made preferred", async () => {
  const service = fixture([addr(1, { is_preferred: true }), addr(2, { not_current: true }), addr(3, { country: "Canada" })]);
  await assert.rejects(service.preview({ id: 42, action: "update", address_id: 999, address: { city: "Orinda" } }), /does not belong/);
  await assert.rejects(service.preview({ id: 42, action: "add", address: { ...NEW, street: "1 old rd", postal_code: "94556" } }), /already exists/);
  await assert.rejects(service.preview({ id: 42, action: "update", address_id: 3, address: { city: "Orinda" } }), /US addresses only/);
  await assert.rejects(service.preview({ id: 42, action: "update", address_id: 2, make_preferred: true }), /not current/);
  assert.equal(service.writes.length, 0);
});

test("a stale preview is rejected when the address list or profile changes", async () => {
  for (const change of [
    s => { s.addresses[1].city = "Lafayette"; },
    s => { s.addresses.push(addr(50)); },
    s => { s.record.groups = []; },
  ]) {
    const service = fixture();
    const preview = await service.preview({ id: 42, action: "mark_inactive", address_id: 2 });
    service.mutate(change);
    await assert.rejects(apply(service, preview), /changed since the preview/);
    assert.equal(service.writes.length, 0);
  }
});

test("a token works once, needs confirmed: true, and is unknown to another session", async () => {
  const service = fixture();
  const preview = await service.preview({ id: 42, action: "mark_inactive", address_id: 2 });
  await assert.rejects(service.apply({ confirmation_token: preview.confirmation_token, confirmed: false }), /Explicit approval/);
  await assert.rejects(apply(fixture(), preview), /Unknown/);
  assert.equal((await apply(service, preview)).verified, true);
  await assert.rejects(apply(service, preview), /already-used/);
  assert.equal(service.writes.length, 1);
});

test("verify step reports mismatches loudly without retrying", async () => {
  const cases = [
    // LGL silently reactivates and prefers the address (the October bug).
    [{ id: 42, action: "mark_inactive", address_id: 2 }, s => { s.addresses[1].not_current = false; s.addresses[1].is_preferred = true; return s; }, /does not match/],
    // LGL saves the new address with a different ZIP.
    [{ id: 42, action: "add", address: NEW }, s => { s.addresses.at(-1).postal_code = "94556"; return s; }, /does not match/],
    // Another address is touched.
    [{ id: 42, action: "update", address_id: 2, address: { city: "Orinda" } }, s => { s.addresses[0].street = "changed"; return s; }, /other address changed/],
    // LGL promotes something else or leaves two preferred.
    [{ id: 42, action: "add", address: NEW, make_preferred: true }, s => { s.addresses[0].is_preferred = true; return s; }, /other address changed/],
    // A profile field changes.
    [{ id: 42, action: "mark_inactive", address_id: 2 }, s => { s.record.addressee = "X"; return s; }, /profile/],
    // The write produced two addresses.
    [{ id: 42, action: "add", address: NEW }, s => { s.addresses.push(addr(77)); return s; }, /exactly one new/],
  ];
  for (const [args, misbehave, pattern] of cases) {
    const service = fixture(undefined, { misbehave });
    const result = await apply(service, await service.preview(args));
    assert.equal(result.status, "verification_failed", JSON.stringify(args));
    assert.equal(result.verified, false);
    assert.match(result.message, /VERIFICATION FAILED/);
    assert.match(JSON.stringify(result.problems), pattern);
    assert.equal(service.writes.length, 1);
  }
});

test("a failed write is not retried and consumes the token", async () => {
  const service = fixture(undefined, { failWrite: new Error("Write failed") });
  const preview = await service.preview({ id: 42, action: "add", address: NEW });
  await assert.rejects(apply(service, preview), /Write failed/);
  await assert.rejects(apply(service, preview), /already-used/);
  assert.equal(service.writes.length, 1);
});

test("post-write unreadable state reports verification unavailable", async () => {
  let reads = 0, writes = 0;
  const service = createAddressUpdateService({
    read: async path => {
      reads++;
      if (reads > 4) throw new Error("private response");
      return path.endsWith("street_addresses") ? { total_items: 1, items: [addr(1, { is_preferred: true })] } : profile();
    },
    patch: async () => { writes++; },
  });
  const preview = await service.preview({ id: 42, action: "update", address_id: 1, address: { city: "Orinda" } });
  const result = await apply(service, preview);
  assert.equal(result.status, "verification_unavailable");
  assert.equal(result.verified, false);
  assert.equal(writes, 1);
});

test("fixed transports hit only the documented endpoints and require both flags", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, method: options.method, body: JSON.parse(options.body) });
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer offline-test-key");
    return { ok: true };
  };
  await postStreetAddress(42, { street: "1 A St", city: "Moraga", state: "CA", postal_code: "94556",
    street_address_type_id: 1, is_preferred: false, not_current: false });
  await patchStreetAddress(7, { is_preferred: false, not_current: true });
  assert.deepEqual(calls.map(c => [c.method, c.url]), [
    ["POST", "https://api.littlegreenlight.com/api/v1/constituents/42/street_addresses"],
    ["PATCH", "https://api.littlegreenlight.com/api/v1/street_addresses/7"],
  ]);
  await assert.rejects(patchStreetAddress(7, { city: "Moraga" }), /explicitly/);
  await assert.rejects(patchStreetAddress(7, { is_preferred: false, not_current: true, country: "US" }), /outside/);
  await assert.rejects(patchStreetAddress("7/x", { is_preferred: false, not_current: true }), /exact/);
  await assert.rejects(postStreetAddress(42, { street: "x", is_preferred: false, not_current: false, email: "a" }), /outside/);
  assert.equal(calls.length, 2);
});

test("write transport failures never retry or leak response bodies", async () => {
  for (const status of [401, 403, 422, 429, 500, "network"]) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (status === "network") throw new Error("private-secret-payload");
      return { ok: false, status, text: async () => "private-secret-payload" };
    };
    await assert.rejects(patchStreetAddress(7, { is_preferred: false, not_current: true }), error => {
      assert.equal(error.message.includes("private-secret-payload"), false);
      assert.match(error.message, /retry|retried/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("single-line guard still allows ordinary multi-part streets", async () => {
  const service = fixture([]);
  for (const street of ["PO Box 94556", "1148 Alpine Road, Suite 100", "12 Main St\nApt 4B", "1 Ca Ave",
    "1200 Maryland Ave, NE", "400 Main St, Ste 10200", "5 Washington St", "10 Main St, Unit B",
    "1 Market St, Ground Fl", "1 Main St, Upper Fl", "1 A St, Unit Pa", "1 A St, Building In",
    "Apt B 94556", "1 Ca Ave Unit 12345"]) {
    const preview = await service.preview({ id: 42, action: "add", address: { ...NEW, street } });
    assert.equal(preview.status, "preview", street);
  }
});

test("every PATCH re-sends the managed fields, so an LGL that resets omitted fields cannot erase them", async () => {
  for (const args of [
    { id: 42, action: "mark_inactive", address_id: 2 },
    { id: 42, action: "update", address_id: 2, make_preferred: true },
    { id: 42, action: "update", address_id: 2, address: { city: "Orinda" } },
  ]) {
    // A fake LGL where any managed field omitted from a PATCH is cleared,
    // generalizing the documented flag quirk.
    const service = fixture(undefined, { resetOmitted: true });
    const preview = await service.preview(args);
    for (const field of ["street", "city", "state", "postal_code", "street_address_type_id", "is_preferred", "not_current"]) {
      assert.ok(Object.hasOwn(preview.request.body, field), `${args.action} omits ${field}`);
    }
    const result = await apply(service, preview);
    assert.equal(result.verified, true, JSON.stringify(result.problems));
  }
});

test("a new address defaults to preferred when no current preferred address exists", async () => {
  const service = fixture([addr(1, { not_current: true, is_preferred: true }), addr(2, { not_current: true })]);
  const preview = await service.preview({ id: 42, action: "add", address: NEW });
  assert.equal(preview.request.body.is_preferred, true);
  assert.match(preview.notes.join(" "), /no current preferred/);
  assert.equal((await apply(service, preview)).verified, true);
  const optOut = await fixture([addr(1, { not_current: true })]).preview({ id: 42, action: "add", address: NEW, make_preferred: false });
  assert.equal(optOut.request.body.is_preferred, false);
  assert.match(optOut.notes.join(" "), /WARNING: .*no current preferred/);
  const normal = await fixture().preview({ id: 42, action: "add", address: NEW });
  assert.equal(normal.request.body.is_preferred, false);
});

test("a preferred address whose siblings are all inactive gives a usable remedy", async () => {
  const service = fixture([addr(1, { is_preferred: true }), addr(2, { not_current: true })]);
  await assert.rejects(service.preview({ id: 42, action: "mark_inactive", address_id: 1 }),
    error => /all inactive/.test(error.message) && /Add the replacement/.test(error.message) && !/update with/.test(error.message));
});

test("an address list without a total count is refused", async () => {
  const service = createAddressUpdateService({
    read: async path => path.endsWith("street_addresses") ? { items: [addr(1)] } : profile(),
  });
  await assert.rejects(service.list({ id: 42 }), /cannot be trusted as complete/);
  await assert.rejects(service.preview({ id: 42, action: "mark_inactive", address_id: 1 }), /cannot be trusted as complete/);
});

test("verification checks every saved field on the target, including defaults on a new address", async () => {
  const cases = [
    [{ id: 42, action: "add", address: NEW }, s => { s.addresses.at(-1).country = "US"; return s; }, "country"],
    [{ id: 42, action: "add", address: NEW }, s => { s.addresses.at(-1).seasonal = true; return s; }, "seasonal"],
    [{ id: 42, action: "update", address_id: 2, address: { city: "Orinda" } }, s => { s.addresses[1].county = "Contra Costa"; return s; }, "county"],
    [{ id: 42, action: "mark_inactive", address_id: 2 }, s => { s.addresses[1].seasonal_to = "06-30"; return s; }, "seasonal_to"],
  ];
  for (const [args, misbehave, field] of cases) {
    const service = fixture(undefined, { misbehave });
    const result = await apply(service, await service.preview(args));
    assert.equal(result.verified, false, field);
    assert.ok(result.problems.some(p => p.fields?.includes(field)), JSON.stringify(result.problems));
  }
  // null and "" are the same empty value in LGL (country is "" on some records).
  const blank = fixture(undefined, { misbehave: s => { s.addresses.at(-1).country = ""; return s; } });
  assert.equal((await apply(blank, await blank.preview({ id: 42, action: "add", address: NEW }))).verified, true);
});

test("verification refuses a saved address that omits a field it should have", async () => {
  for (const [args, drop] of [
    [{ id: 42, action: "add", address: NEW }, "country"],
    [{ id: 42, action: "add", address: NEW }, "county"],
    [{ id: 42, action: "update", address_id: 2, address: { city: "Orinda" } }, "county"],
  ]) {
    const service = fixture(undefined, { misbehave: s => {
      const target = args.action === "add" ? s.addresses.at(-1) : s.addresses.find(a => a.id === 2);
      delete target[drop];
      return s;
    } });
    const result = await apply(service, await service.preview(args));
    assert.equal(result.verified, false, drop);
    assert.ok(result.problems.some(p => p.fields?.includes(drop)), JSON.stringify(result.problems));
  }
});

test("a new street is checked against the saved city; an old single-line street is flagged, not blocked", async () => {
  const service = fixture([addr(1, { is_preferred: true }), addr(2, { street: "2 Old Rd, Moraga, CA 94556" })]);
  await assert.rejects(service.preview({ id: 42, action: "update", address_id: 1, address: { street: "9 New Rd, Moraga" } }), /city, state or ZIP/);
  const preview = await service.preview({ id: 42, action: "mark_inactive", address_id: 2 });
  assert.equal(preview.status, "preview");
  assert.match(preview.notes.join(" "), /still holds city, state or ZIP/);
});
