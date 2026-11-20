// This preload replaces fetch before the MCP server is imported. It cannot
// contact LGL or load real credentials, even if an integration test regresses.
process.env.LGL_API_KEY = "offline-test-key";
const API = "https://api.littlegreenlight.com/api/v1";
let record = { id: 42, is_org: false, first_name: "Alex", last_name: "Example",
  addressee: "Alex Example", relationships: [], email_addresses: [], updated_at: "before" };
let addresses = [{ id: 7, street: "1 Old Rd", city: "Moraga", state: "CA", postal_code: "94556",
  country: null, county: null, seasonal: false, street_address_type_id: 1, street_type_name: "Home",
  is_preferred: true, not_current: false }];
const json = value => ({ ok: true, json: async () => structuredClone(value) });

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  const path = url.origin + url.pathname;
  const method = options.method ?? "GET";
  if (path === `${API}/constituents/42`) {
    if (method === "GET") return json({ ...record, street_addresses: addresses });
    if (method === "PATCH") {
      const payload = JSON.parse(options.body);
      if (Object.keys(payload).some(field => !["first_name", "last_name", "addressee"].includes(field))) {
        throw new Error("Unexpected offline test field");
      }
      record = { ...record, ...payload, updated_at: "after" };
      return { ok: true };
    }
  }
  if (path === `${API}/constituents/42/street_addresses`) {
    if (method === "GET") return json({ total_items: addresses.length, items: addresses });
    if (method === "POST") {
      const body = JSON.parse(options.body);
      if (body.is_preferred) addresses.forEach(a => { a.is_preferred = false; });
      addresses.push({ id: 8, country: null, county: null, seasonal: false, seasonal_from: "01-01",
        seasonal_to: "12-31", street_type_name: "Home", ...body });
      return { ok: true };
    }
  }
  if (path === `${API}/street_addresses/7` && method === "PATCH") {
    Object.assign(addresses[0], JSON.parse(options.body));
    return { ok: true };
  }
  if (path === `${API}/types/street_address_types` && method === "GET") {
    return json({ items: [{ id: 1, name: "Home" }, { id: 2, name: "Work" }] });
  }
  throw new Error("Unexpected offline test request");
};
