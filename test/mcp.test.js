import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("stdio MCP exposes ten tools, validates inputs, and completes a mocked name edit", async () => {
  const client = new Client({ name: "offline-test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [
    "--import", fileURLToPath(new URL("./fixtures/mock-api.js", import.meta.url)),
    fileURLToPath(new URL("../index.js", import.meta.url)),
  ], env: { LGL_API_KEY: "offline-test-key" }, stderr: "pipe" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 10);
    for (const name of ["search_constituents", "get_constituent", "get_constituent_gifts",
      "search_gifts", "list_funds", "list_appeals", "list_gift_categories", "list_gift_types"]) {
      assert.ok(tools.find(tool => tool.name === name));
    }
    const previewTool = tools.find(tool => tool.name === "preview_constituent_name_update");
    const writeTool = tools.find(tool => tool.name === "apply_constituent_name_update");
    assert.equal(previewTool.annotations.readOnlyHint, true);
    assert.equal(writeTool.annotations.readOnlyHint, false);
    assert.equal(writeTool.annotations.idempotentHint, false);
    assert.equal(tools.some(tool => /steward/.test(tool.name)), false);

    const bad = await client.callTool({ name: previewTool.name, arguments: { id: 42, changes: { steward: "Rob Pierson" } } });
    assert.equal(bad.isError, true);
    const result = await client.callTool({ name: previewTool.name, arguments: {
      id: 42, changes: { addressee: "Alex & Pat Example" },
    } });
    assert.notEqual(result.isError, true);
    const preview = JSON.parse(result.content[0].text);
    const declined = await client.callTool({ name: writeTool.name, arguments: { confirmation_token: preview.confirmation_token, confirmed: false } });
    assert.equal(declined.isError, true);
    const applied = await client.callTool({ name: writeTool.name, arguments: { confirmation_token: preview.confirmation_token, confirmed: true } });
    assert.notEqual(applied.isError, true);
    assert.equal(JSON.parse(applied.content[0].text).verified, true);
    const fetched = await client.callTool({ name: "get_constituent", arguments: { id: 42, verbose: true } });
    assert.equal(JSON.parse(fetched.content[0].text).addressee, "Alex & Pat Example");
  } finally { await client.close(); }
});
