import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configSchema } from "../src/config.js";
import { CodexBackend } from "../src/codex/backend.js";
import { OBSERVATION_SERVER, OBSERVATION_TOOLS, SNAPSHOT_SERVER, SNAPSHOT_TOOLS, McpFabricObservation, allowedSnapshotCall, summarizeTerrain } from "../src/mcp/observation.js";
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

test("terrain summary identifies a local one-block depression", () => {
  const blocks = [];
  for (let z = -1; z <= 1; z++) for (let x = -1; x <= 1; x++) {
    const y = x === 0 && z === 0 ? 62 : 63;
    blocks.push({ x, y, z, id: x === 0 && z === 0 ? "minecraft:dirt" : "minecraft:grass_block" });
  }
  const summary = summarizeTerrain({ x: -1, y: 60, z: -1 }, { x: 1, y: 66, z: 1 }, blocks);
  assert.equal(summary.depressions[0]?.x, 0);
  assert.equal(summary.depressions[0]?.z, 0);
  assert.equal(summary.depressions[0]?.airStartY, 63);
});

test("terrain summary does not invent a pit when no solid surface was captured", () => {
  const blocks = [
    { x: 0, y: 63, z: -1, id: "minecraft:grass_block" },
    { x: 0, y: 63, z: 1, id: "minecraft:grass_block" },
    { x: -1, y: 63, z: 0, id: "minecraft:grass_block" },
    { x: 1, y: 63, z: 0, id: "minecraft:grass_block" },
  ];
  const summary = summarizeTerrain({ x: -1, y: 60, z: -1 }, { x: 1, y: 66, z: 1 }, blocks);
  assert.equal(summary.depressions.some(depression => depression.topBlock === "minecraft:air"), false);
});

test("recommended balances pit depth and player distance", () => {
  const blocks = [];
  for (let z = -3; z <= 3; z++) for (let x = -3; x <= 3; x++) blocks.push({ x, z, y: 63, id: "minecraft:grass_block" });
  const deep = blocks.find(block => block.x === 0 && block.z === 0); deep.y = 60;
  const shallow = blocks.find(block => block.x === 2 && block.z === 0); shallow.y = 62;
  const summary = summarizeTerrain({ x: -3, y: 59, z: -3 }, { x: 3, y: 64, z: 3 }, blocks, { x: 3, z: 0 });
  assert.equal(summary.recommended?.x, 0);
  assert.equal(summary.recommended?.z, 0);
});

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
  assert.deepEqual(config[`mcp_servers.${SNAPSHOT_SERVER}.enabled_tools`], [...SNAPSHOT_TOOLS]);
  assert.equal(config[`mcp_servers.${SNAPSHOT_SERVER}.required`], true);
  assert.equal(config["mcp_servers.dangerous.enabled"], false);
  assert.equal(start.params.sandbox, "read-only");
  assert.match(start.params.developerInstructions, /mccodex_observe\/get_blocks_region/);
  assert.match(start.params.developerInstructions, /SNAPSHOT_OUT_OF_RANGE/);
  assert.match(start.params.developerInstructions, /get_snapshot_layer/);
  assert.match(start.params.cwd, /codex-observe-workspace$/);
  const turns = requests.filter(m => m.method === "turn/start");
  assert.equal(turns.length, 2);
  for (const turn of turns) {
    assert.match(turn.params.input[0].text, /"x":10,"y":65,"z":20/);
    assert.match(turn.params.input[0].text, /"name":"nearby"/);
    assert.match(turn.params.input[0].text, /"name":"overhead"/);
    assert.match(turn.params.input[0].text, /coverageNote/);
    assert.match(turn.params.input[0].text, /mccodex_observe\/get_block/);
    assert.match(turn.params.input[0].text, /get_snapshot_layer/);
    assert.match(turn.params.input[0].text, /"lookingAt":\{"type":"block","id":"minecraft:dirt","pos":\{"x":10,"y":64,"z":20\}/);
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

for (const text of ["world-read-failed", "forbidden-tool", "snapshot-forbidden"]) {
  test(`stops a turn on ${text}`, async t => {
    const { backend } = await setup(t);
    await assert.rejects(backend.run("world", text, new AbortController().signal, () => {}), /[\u53ea\u8bfb\u8303\u56f4]/);
  });
}

test("snapshot query misses are returned to the model instead of failing the task", async t => {
  const { backend } = await setup(t);
  assert.equal(await backend.run("world", "snapshot-recover", new AbortController().signal, () => {}), "fixture: snapshot recovered");
  assert.equal(allowedSnapshotCall(SNAPSHOT_SERVER, "get_snapshot_region"), true);
  assert.equal(allowedSnapshotCall(SNAPSHOT_SERVER, "get_snapshot_layer"), true);
  assert.equal(allowedSnapshotCall(SNAPSHOT_SERVER, "set_block"), false);
  assert.equal(allowedSnapshotCall(OBSERVATION_SERVER, "get_snapshot_region"), false);
});

test("model may read the live world when snapshot coverage is missing", async t => {
  const { backend } = await setup(t);
  assert.equal(await backend.run("world", "snapshot-fallback", new AbortController().signal, () => {}), "fixture: snapshot live fallback");
  assert.equal(allowedSnapshotCall(SNAPSHOT_SERVER, "get_snapshot_region"), true);
  assert.equal(allowedSnapshotCall(OBSERVATION_SERVER, "get_block"), false);
});

test("diagnostic adapter refuses write tools before sending any RPC", async t => {
  const rpc = new RpcClient(process.execPath, [fixture], process.cwd(), 1000);
  t.after(() => rpc.close());
  const adapter = new McpFabricObservation(rpc, "test");
  await assert.rejects(adapter.call("set_block"), /[\u62d2\u7edd\u5de5\u5177]/);
  await assert.rejects(adapter.call("run_command"), /[\u62d2\u7edd\u5de5\u5177]/);
});
