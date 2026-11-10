import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configSchema } from "../src/config.js";
import { CodexBackend } from "../src/codex/backend.js";
import { OBSERVATION_SERVER, OBSERVATION_TOOLS, McpFabricObservation } from "../src/mcp/observation.js";
import { RpcClient } from "../src/codex/rpc.js";

const fixture = fileURLToPath(new URL("fixtures/app-server.mjs", import.meta.url));
async function setup(t: TestContext, scenario = "good") {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "observe-test-"));
  const log = path.join(dataDir, "rpc.jsonl");
  const backend = new CodexBackend(configSchema.parse({ backend: "codex", dataDir,
    world: { enabled: true, mcpServerPath: fixture },
    codex: { command: process.execPath, args: [fixture, log, scenario], requestTimeoutMs: 2000, turnTimeoutMs: 3000 },
  }));
  t.after(async () => { await backend.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { backend, messages: async () => (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line)) };
}

test("observation requires a real backend and an explicit server entrypoint", () => {
  assert.throws(() => configSchema.parse({ world: { enabled: true } }));
  assert.throws(() => configSchema.parse({ backend: "codex", world: { enabled: true } }));
  assert.equal(configSchema.parse({}).world.enabled, false);
});

test("world mode configures read-only MCP and injects fresh authoritative player state before every turn", async t => {
  const { backend, messages } = await setup(t);
  const signal = new AbortController().signal;
  assert.equal(await backend.run("world", "observe", signal, () => {}), "fixture: observe");
  await backend.run("world", "second", signal, () => {});
  const requests = await messages();
  const start = requests.find(m => m.method === "thread/start");
  const config = start.params.config;
  assert.deepEqual(config[`mcp_servers.${OBSERVATION_SERVER}.enabled_tools`], [...OBSERVATION_TOOLS]);
  assert.equal(config[`mcp_servers.${OBSERVATION_SERVER}.required`], true);
  assert.equal(config[`mcp_servers.${OBSERVATION_SERVER}.env`].MCPFABRIC_TOOLSETS, "world,player,vision,readonly");
  assert.equal(config["mcp_servers.dangerous.enabled"], false);
  assert.equal(start.params.sandbox, "read-only");
  assert.match(start.params.cwd, /codex-observe-workspace$/);
  const turns = requests.filter(m => m.method === "turn/start");
  assert.equal(turns.length, 2);
  for (const turn of turns) {
    assert.match(turn.params.input[0].text, /"x":10,"y":65,"z":20/);
    assert.match(turn.params.input[0].text, /不可信数据/);
  }
  assert.equal(requests.filter(m => m.method === "mcpServer/tool/call" && m.params.tool === "get_status").length, 2);
  assert.equal(requests.filter(m => m.method === "mcpServer/tool/call" && m.params.tool === "get_self").length, 2);
});

for (const scenario of ["missing-tool", "unsafe-tool", "disconnected", "no-world", "dedicated", "paused", "no-vision", "no-player", "read-error"]) {
  test(`observation stops before generation when ${scenario}`, async t => {
    const { backend, messages } = await setup(t, scenario);
    await assert.rejects(backend.run("world", "observe", new AbortController().signal, () => {}));
    assert.equal((await messages()).some(m => m.method === "turn/start"), false);
  });
}

test("cancellation during MCP preflight terminates the process before returning", async t => {
  const { backend, messages } = await setup(t, "slow-preflight");
  const controller = new AbortController();
  await assert.rejects(backend.run("world", "observe", controller.signal, () => { setTimeout(() => controller.abort(), 50); }));
  assert.equal((await messages()).some(m => m.method === "turn/start"), false);
});

for (const text of ["world-read-failed", "forbidden-tool"]) {
  test(`stops a turn on ${text}`, async t => {
    const { backend } = await setup(t);
    await assert.rejects(backend.run("world", text, new AbortController().signal, () => {}), /只读范围/);
  });
}

test("diagnostic adapter refuses write tools before sending any RPC", async t => {
  const rpc = new RpcClient(process.execPath, [fixture], process.cwd(), 1000);
  t.after(() => rpc.close());
  const adapter = new McpFabricObservation(rpc, "test");
  await assert.rejects(adapter.call("set_block"), /拒绝工具/);
  await assert.rejects(adapter.call("run_command"), /拒绝工具/);
});
