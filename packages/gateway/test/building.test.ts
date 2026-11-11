import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexBackend } from "../src/codex/backend.js";
import { TaskManager } from "../src/task-manager.js";
import { configSchema } from "../src/config.js";
import type { BuildProposal } from "../src/backend.js";
import { until } from "./helpers.js";

const fixture = fileURLToPath(new URL("fixtures/app-server.mjs", import.meta.url));
async function setup(t: TestContext, scenario = "build-good", overrides = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "build-test-"));
  const log = path.join(dataDir, "rpc.jsonl");
  const config = configSchema.parse({ backend: "codex", dataDir, world: { enabled: true, mcpServerPath: fixture }, building: { enabled: true, ...overrides },
    codex: { command: process.execPath, args: [fixture, log, scenario], requestTimeoutMs: 2000, turnTimeoutMs: 5000 } });
  const backend = new CodexBackend(config);
  const manager = new TaskManager(backend, 20, () => {}, () => {});
  await manager.setWorld("world");
  t.after(async () => { await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  const messages = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const writes = async () => (await messages()).filter(m => m.method === "mcpServer/tool/call" && ["set_block", "fill_blocks"].includes(m.params.tool));
  const task = () => manager.list("world")[0]!;
  return { backend, manager, messages, writes, task, config };
}

test("building stays disabled unless observation is enabled", () => {
  assert.throws(() => configSchema.parse({ building: { enabled: true } }));
  assert.equal(configSchema.parse({}).building.enabled, false);
});

test("approval remains valid without a configured deadline", async t => {
  const s = await setup(t, "build-good", { approvalTimeoutMs: 0 });
  const task = s.manager.submit("world", "建造小石砖柱");
  await until(() => s.task().status === "AWAITING_APPROVAL");
  assert.equal(s.task().build?.expiresAt, undefined);
  await new Promise(resolve => setTimeout(resolve, 150));
  s.manager.approve("world");
  await until(() => s.task().status === "COMPLETED");
  assert.equal((await s.writes()).length, 2);
});
test("no writes before approval; executes and verifies an approved immutable plan exactly once", async t => {
  const s = await setup(t);
  const task = s.manager.submit("world", "建造小石砖柱");
  await until(() => s.task().status === "AWAITING_APPROVAL");
  assert.equal((await s.writes()).length, 0);
  assert.equal(s.task().build?.changedBlocks, 4);
  const publicCopy = s.task();
  publicCopy.build!.operations[0]!.blockId = "minecraft:glass";
  assert.equal(s.task().build?.operations[0]?.blockId, "minecraft:stone_bricks");
  await writeFile(s.task().build!.planFile, JSON.stringify({ malicious: "modified plan file is not executable" }));
  assert.throws(() => s.manager.approve("other-world", task.id));
  s.manager.approve("world");
  assert.throws(() => s.manager.approve("world", task.id));
  await until(() => s.task().status === "COMPLETED");
  const writes = await s.writes();
  assert.equal(writes.length, 2);
  assert(writes.every(m => m.params.server === "mccodex_execute" && m.params.arguments.blockId === "minecraft:stone_bricks"));
  const requests = await s.messages();
  const writer = requests.find(m => m.method === "thread/start" && m.params.config["mcp_servers.mccodex_execute.enabled"]);
  assert(writer);
  assert.equal(requests.filter(m => m.method === "turn/start").length, 2); // planning + visual review, neither on writer
  assert(requests.filter(m => m.method === "turn/start").every(m => m.params.threadId === "fixture-thread-1"));
});

for (const action of ["reject", "cancel", "world-change", "expire"]) {
  test(`${action} never authorizes a pending plan`, async t => {
    const s = await setup(t, "build-good", action === "expire" ? { approvalTimeoutMs: 100 } : {});
    const task = s.manager.submit("world", "建造小柱");
    await until(() => s.task().status === "AWAITING_APPROVAL");
    if (action === "reject") s.manager.reject("world");
    if (action === "cancel") s.manager.cancel("world", task.id);
    if (action === "world-change") await s.manager.setWorld("other");
    else await until(() => ["FAILED", "CANCELLED"].includes(s.task().status));
    assert.equal((await s.writes()).length, 0);
  });
}

for (const scenario of ["build-occupied", "build-truncated", "build-incomplete", "build-no-write", "build-no-control"]) {
  test(`${scenario} refuses a plan before approval`, async t => {
    const s = await setup(t, scenario);
    s.manager.submit("world", "建造小柱");
    await until(() => s.task().status === "FAILED");
    assert.equal((await s.writes()).length, 0);
  });
}

for (const scenario of ["build-stale", "build-world-change", "build-write-error", "build-readback-error", "build-mid-world-change"]) {
  test(`${scenario} stops execution and never retries`, async t => {
    const s = await setup(t, scenario);
    const task = s.manager.submit("world", "建造小柱");
    await until(() => s.task().status === "AWAITING_APPROVAL");
    s.manager.approve("world", task.id);
    await until(() => s.task().status === "FAILED");
    const writes = await s.writes();
    const expected = scenario === "build-write-error" ? 2 : ["build-readback-error", "build-mid-world-change"].includes(scenario) ? 1 : 0;
    assert.equal(writes.length, expected);
    assert.throws(() => s.manager.approve("world", task.id));
  });
}

test("backend execution grant is bound to session and is single use", async t => {
  const s = await setup(t);
  const result = await s.backend.run("world", "建造", new AbortController().signal, () => {});
  assert.equal(typeof result, "object");
  const proposal = result as BuildProposal;
  await assert.rejects(s.backend.executeBuild("other", proposal, new AbortController().signal, () => {}, () => {}));
  await s.backend.executeBuild("world", proposal, new AbortController().signal, () => {}, () => {});
  await assert.rejects(s.backend.executeBuild("world", proposal, new AbortController().signal, () => {}, () => {}));
});

test("overwriting is counted and requires explicit configuration plus approval", async t => {
  const s = await setup(t, "build-occupied", { allowOverwrite: true });
  const task = s.manager.submit("world", "替换模拟柱");
  await until(() => s.task().status === "AWAITING_APPROVAL");
  assert.equal(s.task().build?.overwrittenBlocks, 4);
  assert.equal((await s.writes()).length, 0);
  s.manager.approve("world", task.id);
  await until(() => s.task().status === "COMPLETED");
  assert.equal((await s.writes()).length, 2);
});

test("cancelling an in-flight write does not send the next batch", async t => {
  const s = await setup(t, "build-slow-write");
  const task = s.manager.submit("world", "建造小柱");
  await until(() => s.task().status === "AWAITING_APPROVAL");
  s.manager.approve("world", task.id);
  const deadline = Date.now() + 5000;
  while (!(await s.writes()).length) {
    assert(Date.now() < deadline);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  s.manager.cancel("world", task.id);
  await until(() => s.task().status === "CANCELLED");
  assert.equal((await s.writes()).length, 1);
  assert.match(s.task().error!, /不自动回滚/);
});

test("an awaiting approval blocks later tasks until rejection", async t => {
  const s = await setup(t);
  const first = s.manager.submit("world", "建造一");
  const second = s.manager.submit("world", "建造二");
  await until(() => s.task().status === "AWAITING_APPROVAL");
  assert.equal(s.manager.list("world").find(task => task.id === second.id)?.status, "QUEUED");
  assert.equal((await s.messages()).filter(m => m.method === "turn/start").length, 1);
  s.manager.reject("world", first.id);
  await until(() => s.manager.list("world").find(task => task.id === second.id)?.status === "AWAITING_APPROVAL");
  assert.equal((await s.writes()).length, 0);
});
