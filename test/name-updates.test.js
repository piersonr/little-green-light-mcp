import test from "node:test";
import assert from "node:assert/strict";
import { createNameUpdateService, patchConstituentName } from "../name-updates.js";

// Never load real credentials or send network traffic in this suite.
process.env.LGL_API_KEY = "offline-test-key";
globalThis.fetch = async () => { throw new Error("Unexpected network call in an offline test"); };

const base = () => ({
  id: 42, is_org: false, first_name: "Alex", middle_name: "", last_name: "Example",
  addressee: "Alex Example", spouse_name: "", org_name: "Employer Example",
  relationships: [], email_addresses: [{ id: 1, address: "test@example.invalid" }],
  groups: [{ id: 2, name: "Existing" }], is_deceased: false, updated_at: "before",
});

function fixture(initial = base(), transform = record => record) {
  let record = structuredClone(initial);
  const reads = [], writes = [];
  const service = createNameUpdateService({
    read: async path => { reads.push(path); return structuredClone(record); },
    patch: async (id, payload) => {
      writes.push({ id, payload: structuredClone(payload) });
      record = transform({ ...record, ...payload, updated_at: "after" });
    },
  });
  return { ...service, reads, writes, change: updates => Object.assign(record, updates) };
}
const prepare = service => service.preview({ id: 42, changes: { addressee: "Alex & Pat Example" } });
const apply = (service, preview) => service.apply({ confirmation_token: preview.confirmation_token, confirmed: true });

test("preview reads once, shows exact changes and sends no update", async () => {
  const service = fixture();
  const result = await prepare(service);
  assert.equal(result.status, "preview");
  assert.deepEqual(result.changes, [{ field: "addressee", before: "Alex Example", after: "Alex & Pat Example" }]);
  assert.match(result.confirmation_token, /^[a-f0-9]{48}$/);
  assert.match(result.instruction, /token is not approval/);
  assert.deepEqual(service.reads, ["/constituents/42"]);
  assert.equal(service.writes.length, 0);
  assert.equal(JSON.stringify(result).includes("email_addresses"), false);
});

test("apply preserves contact data and other names, verifies, and consumes token", async () => {
  const service = fixture();
  const preview = await prepare(service);
  const result = await apply(service, preview);
  assert.equal(result.status, "updated");
  assert.equal(result.verified, true);
  assert.deepEqual(service.writes, [{ id: 42, payload: {
    addressee: "Alex & Pat Example",
  } }]);
  assert.equal(service.reads.length, 3);
  await assert.rejects(apply(service, preview), /already-used/);
  assert.equal(service.writes.length, 1);
});

test("already-correct values return unchanged without a confirmation token", async () => {
  const service = fixture();
  const result = await service.preview({ id: 42, changes: { first_name: " Alex " } });
  assert.equal(result.status, "unchanged");
  assert.equal(result.confirmation_token, undefined);
  assert.equal(service.writes.length, 0);
});

test("strict allowlist rejects stewards, contact data, flags, empty changes, and malformed text", async () => {
  const service = fixture();
  for (const changes of [{ steward: "Rob Pierson" }, { email_addresses: [] }, { is_org: true },
    {}, [], null, { first_name: 7 }, { first_name: "a\nb" }, { first_name: "a".repeat(251) }]) {
    await assert.rejects(service.preview({ id: 42, changes }));
  }
  assert.equal(service.reads.length, 0);
  assert.equal(service.writes.length, 0);
});

test("only exact positive constituent IDs are accepted", async () => {
  const service = fixture();
  for (const id of [0, -1, 1.5, "42/gifts", "42?x=y", "042", "1e3", Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(service.preview({ id, changes: { first_name: "Pat" } }), /exact LGL constituent ID/);
  }
  assert.equal(service.reads.length, 0);
});

test("wrong or incomplete read records cannot be used for a preview", async () => {
  for (const record of [{ ...base(), id: 99 }, { ...base(), is_org: undefined }, { ...base(), first_name: 9 }]) {
    await assert.rejects(prepare(fixture(record)));
  }
});

test("a requested field omitted from the API response is not assumed blank", async () => {
  const record = base();
  delete record.addressee;
  const service = fixture(record);
  await assert.rejects(prepare(service), /existing value cannot be previewed/);
  assert.equal(service.writes.length, 0);
});

test("individual employer and organization contact names cannot be changed", async () => {
  await assert.rejects(fixture().preview({ id: 42, changes: { org_name: "Other employer" } }), /employer/);
  const org = fixture({ ...base(), is_org: true, org_name: "Example Charity" });
  await assert.rejects(org.preview({ id: 42, changes: { first_name: "Pat" } }), /Contact-person/);
  const preview = await org.preview({ id: 42, changes: { org_name: "Example Foundation" } });
  assert.equal((await apply(org, preview)).verified, true);
  assert.deepEqual(org.writes[0].payload, { org_name: "Example Foundation" });
});

test("blank resulting prospect names are refused; explicit optional-field clearing works", async () => {
  await assert.rejects(fixture().preview({ id: 42, changes: { first_name: "", last_name: "" } }), /without a name/);
  await assert.rejects(fixture({ ...base(), is_org: true }).preview({ id: 42, changes: { org_name: " " } }), /without a name/);
  const service = fixture({ ...base(), middle_name: "Q" });
  const preview = await service.preview({ id: 42, changes: { middle_name: "" } });
  assert.equal((await apply(service, preview)).verified, true);
});

test("linked or uninspected spouse relationships refuse spouse-name edits", async () => {
  for (const relationships of [[{ name: "Spouse" }], [{ name: "Domestic partner" }], undefined]) {
    await assert.rejects(fixture({ ...base(), relationships }).preview({ id: 42, changes: { spouse_name: "Pat Example" } }), /spouse|Spouse/);
  }
  const service = fixture();
  const preview = await service.preview({ id: 42, changes: { spouse_name: "Pat Example" } });
  assert.equal((await apply(service, preview)).verified, true);
});

test("exact approval required and a token from another session is refused", async () => {
  const service = fixture();
  const preview = await prepare(service);
  await assert.rejects(service.apply({ confirmation_token: preview.confirmation_token, confirmed: false }), /Explicit approval/);
  await assert.rejects(apply(fixture(), preview), /Unknown/);
  assert.equal(service.writes.length, 0);
  assert.equal((await apply(service, preview)).verified, true);
});

test("changes to any constituent data after preview refuse the write", async () => {
  for (const change of [{ first_name: "Someone else" }, { groups: [] }, { updated_at: "changed" }]) {
    const service = fixture();
    const preview = await prepare(service);
    service.change(change);
    await assert.rejects(apply(service, preview), /changed since the preview/);
    assert.equal(service.writes.length, 0);
  }
});

test("a second concurrent write to the same constituent is refused", async () => {
  let finish;
  const wait = new Promise(resolve => { finish = resolve; });
  let writes = 0;
  const record = base();
  const service = createNameUpdateService({
    read: async () => structuredClone(record),
    patch: async (_id, payload) => { writes++; await wait; Object.assign(record, payload); },
  });
  const first = await prepare(service), second = await prepare(service);
  const running = apply(service, first);
  await assert.rejects(apply(service, second), /running/);
  finish();
  assert.equal((await running).verified, true);
  assert.equal(writes, 1);
});

test("ignored names or changes to other profile data fail verification without a retry", async () => {
  for (const [transform, field] of [
    [record => ({ ...record, addressee: "Alex Example" }), "mismatched_name_fields"],
    [record => ({ ...record, first_name: "Unexpected" }), "mismatched_name_fields"],
    [record => ({ ...record, groups: [] }), "unexpected_changed_fields"],
  ]) {
    const service = fixture(base(), transform);
    const result = await apply(service, await prepare(service));
    assert.equal(result.status, "verification_failed");
    assert.equal(result.verified, false);
    assert.ok(result[field].length);
    assert.equal(service.writes.length, 1);
  }
});

test("post-write missing, wrong, or malformed records report verification unavailable honestly", async () => {
  for (const saved of [null, { ...base(), id: 99 }, { ...base(), first_name: 9 }, "throw"]) {
    let reads = 0, writes = 0;
    const service = createNameUpdateService({
      read: async () => {
        if (++reads < 3) return base();
        if (saved === "throw") throw new Error("private response");
        return saved;
      },
      patch: async () => { writes++; },
    });
    const result = await apply(service, await prepare(service));
    assert.equal(result.status, "verification_unavailable");
    assert.equal(result.verified, false);
    assert.match(result.message, /update was sent/);
    assert.equal(writes, 1);
  }
});

test("fixed PATCH transport sends only allowed fields and retains existing name spacing", async () => {
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, "https://api.littlegreenlight.com/api/v1/constituents/42");
    assert.equal(options.method, "PATCH");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer offline-test-key");
    assert.deepEqual(JSON.parse(options.body), { first_name: " Alex ", last_name: "Example", addressee: "Alex & Pat Example" });
    return { ok: true };
  };
  await patchConstituentName(42, { first_name: " Alex ", last_name: "Example", addressee: "Alex & Pat Example" });
  await assert.rejects(patchConstituentName(42, { email_addresses: [] }), /outside/);
  await assert.rejects(patchConstituentName("42/gifts", { first_name: "Pat" }), /exact/);
  assert.equal(calls, 1);
});

test("write failures never retry, broaden payloads, or expose private response data", async () => {
  for (const status of [401, 403, 422, 429, 500, "network"]) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (status === "network") throw new Error("private-secret-payload");
      return { ok: false, status, text: async () => "private-secret-payload" };
    };
    await assert.rejects(patchConstituentName(42, { first_name: "Pat" }), error => {
      assert.equal(error.message.includes("private-secret-payload"), false);
      assert.match(error.message, /retry|retried/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("failed write consumes its token and cannot be replayed", async () => {
  let writes = 0;
  const service = createNameUpdateService({ read: async () => base(), patch: async () => { writes++; throw new Error("Write failed"); } });
  const preview = await prepare(service);
  await assert.rejects(apply(service, preview), /Write failed/);
  await assert.rejects(apply(service, preview), /already-used/);
  assert.equal(writes, 1);
});

test("a saved record that omits a written or previously present name field is not counted as verified", async () => {
  for (const drop of ["middle_name", "addressee"]) {
    let reads = 0;
    const record = { ...base(), middle_name: "Q" };
    const service = createNameUpdateService({
      read: async () => {
        reads++;
        const copy = structuredClone(record);
        if (reads >= 3) delete copy[drop];
        return copy;
      },
      patch: async (_id, payload) => Object.assign(record, payload),
    });
    const preview = await service.preview({ id: 42, changes: { middle_name: "" } });
    const result = await apply(service, preview);
    assert.equal(result.status, "verification_unavailable", drop);
    assert.equal(result.verified, false);
  }
});

test("a name change without addressee warns that addressee and salutation will not recalculate", async () => {
  const noted = await fixture().preview({ id: 42, changes: { last_name: "Exemplar" } });
  assert.match(noted.notes.join(" "), /does not recalculate addressee/);
  const withAddressee = await fixture().preview({ id: 42, changes: { last_name: "Exemplar", addressee: "Alex Exemplar" } });
  assert.equal(withAddressee.notes, undefined);
  assert.equal((await prepare(fixture())).notes, undefined);
});

test("name and address writes share one per-constituent lock", async () => {
  const { createAddressUpdateService } = await import("../address-updates.js");
  let finish;
  const wait = new Promise(resolve => { finish = resolve; });
  const record = base();
  const addresses = [{ id: 7, street: "1 A St", city: "Moraga", state: "CA", postal_code: "94556",
    street_address_type_id: 1, is_preferred: false, not_current: false }];
  const read = async path => path.endsWith("street_addresses")
    ? { total_items: 1, items: structuredClone(addresses) } : structuredClone(record);
  let addressWrites = 0;
  const names = createNameUpdateService({ read, patch: async (_id, payload) => { await wait; Object.assign(record, payload); } });
  const places = createAddressUpdateService({ read, patch: async () => { addressWrites++; } });
  const namePreview = await prepare(names);
  const addressPreview = await places.preview({ id: 42, action: "mark_inactive", address_id: 7 });
  const running = apply(names, namePreview);
  await assert.rejects(places.apply({ confirmation_token: addressPreview.confirmation_token, confirmed: true }), /running/);
  finish();
  assert.equal((await running).verified, true);
  assert.equal(addressWrites, 0);
});

test("the shared lock blocks a name write during an address write and is released after a failed apply", async () => {
  const { createAddressUpdateService } = await import("../address-updates.js");
  let finish;
  const wait = new Promise(resolve => { finish = resolve; });
  const record = base();
  const addresses = [{ id: 7, street: "1 A St", city: "Moraga", state: "CA", postal_code: "94556",
    street_address_type_id: 1, is_preferred: false, not_current: false }];
  const read = async path => path.endsWith("street_addresses")
    ? { total_items: 1, items: structuredClone(addresses) } : structuredClone(record);
  let nameWrites = 0, failNext = true;
  const names = createNameUpdateService({ read, patch: async (_id, payload) => { nameWrites++; Object.assign(record, payload); } });
  const places = createAddressUpdateService({ read, patch: async (_id, body) => {
    if (failNext) { failNext = false; throw new Error("Write failed"); }
    await wait; Object.assign(addresses[0], body);
  } });

  // A failed address apply releases the lock.
  const failing = await places.preview({ id: 42, action: "mark_inactive", address_id: 7 });
  await assert.rejects(places.apply({ confirmation_token: failing.confirmation_token, confirmed: true }), /Write failed/);

  // While an address apply is in flight, a name apply is refused.
  const addressPreview = await places.preview({ id: 42, action: "mark_inactive", address_id: 7 });
  const namePreview = await prepare(names);
  const running = places.apply({ confirmation_token: addressPreview.confirmation_token, confirmed: true });
  await assert.rejects(apply(names, namePreview), /running/);
  finish();
  assert.equal((await running).verified, true);
  assert.equal(nameWrites, 0);

  // After it finishes, a fresh name update proceeds.
  assert.equal((await apply(names, await prepare(names))).verified, true);
  assert.equal(nameWrites, 1);
});
