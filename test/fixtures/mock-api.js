// This preload replaces fetch before the MCP server is imported. It cannot
// contact LGL or load real credentials, even if an integration test regresses.
process.env.LGL_API_KEY = "offline-test-key";
let record = { id: 42, is_org: false, first_name: "Alex", last_name: "Example",
  addressee: "Alex Example", relationships: [], email_addresses: [], updated_at: "before" };
globalThis.fetch = async (url, options = {}) => {
  if (String(url) !== "https://api.littlegreenlight.com/api/v1/constituents/42") {
    throw new Error("Unexpected offline test URL");
  }
  if (options.method === "GET") return { ok: true, json: async () => structuredClone(record) };
  if (options.method === "PATCH") {
    const payload = JSON.parse(options.body);
    if (Object.keys(payload).some(field => !["first_name", "last_name", "addressee"].includes(field))) {
      throw new Error("Unexpected offline test field");
    }
    record = { ...record, ...payload, updated_at: "after" };
    return { ok: true };
  }
  throw new Error("Unexpected offline test method");
};
