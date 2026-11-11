import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexBackend } from "../src/codex/backend.js";
import { configSchema, loadToken, authenticated } from "../src/config.js";
import type { RpcMessage } from "../src/codex/rpc.js";
import { existsSync, readFileSync } from "node:fs";
import { until } from "./helpers.js";

const fixture = fileURLToPath(new URL("fixtures/app-server.mjs", import.meta.url));
async function setup(t: any, timeouts = {}, scenario = "good") {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codex-test-"));
  const log = path.join(dataDir, "rpc.jsonl");
  const backend = new CodexBackend(configSchema.parse({ dataDir, codex: { command: process.execPath, args: [fixture, log, scenario], requestTimeoutMs: 2000, turnTimeoutMs: 3000, ...timeouts } }));
  t.after(async () => { await backend.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { backend, log, dataDir, messages: async () => (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as RpcMessage) };
}
const signal = () => new AbortController().signal;

test("starts npm-style .cmd shims on Windows", { skip: process.platform !== "win32", timeout: 10000 }, async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codex-shim-test-"));
  const shimDir = path.join(dataDir, "shim dir");
  await mkdir(shimDir, { recursive: true });
  const log = path.join(dataDir, "rpc.jsonl");
  const shim = path.join(shimDir, "app-server.cmd");
  await writeFile(shim, `@echo off\r\n"${process.execPath}" "${fixture}" "${log}"\r\n`, "utf8");
  const backend = new CodexBackend(configSchema.parse({ dataDir, codex: { command: shim, args: [], requestTimeoutMs: 2000, turnTimeoutMs: 3000 } }));
  t.after(async () => { await backend.close(); await rm(dataDir, { recursive: true, force: true }); });
  assert.equal(await backend.run("world", "cmd-shim", signal(), () => {}), "fixture: cmd-shim");
  assert.equal((await readFile(log, "utf8")).includes('"method":"thread/start"'), true);
});
test("adapter reuses its thread, handles early notifications, resets on world change", async t => {
  const { backend, messages } = await setup(t);
  assert.equal(await backend.run("world", "early", signal(), () => {}), "fixture: early");
  assert.equal(await backend.run("world", "second", signal(), () => {}), "fixture: second");
  await backend.reset("world");
  assert.equal(await backend.run("new-world", "third", signal(), () => {}), "fixture: third");
  const requests = await messages();
  assert.equal(requests.filter(m => m.method === "initialize").length, 1);
  assert.equal(requests.filter(m => m.method === "thread/start").length, 2);
  assert.equal(requests.filter(m => m.method === "thread/resume").length, 1);
  const started = requests.find(m => m.method === "thread/start")!;
  assert.equal(started.params.sandbox, "read-only");
  assert.equal(started.params.approvalPolicy, "untrusted");
  assert.equal(started.params.config["mcp_servers.dangerous.enabled"], false);
});

test("adapter declines shell and file approvals instead of silently approving", async t => {
  const { backend, messages } = await setup(t);
  await backend.run("world", "approval", signal(), () => {});
  const replies = (await messages()).filter(m => m.id === "approval-1" || m.id === "approval-2");
  assert.equal(replies.length, 2);
  assert.deepEqual(replies.map(m => m.result), [{ decision: "decline" }, { decision: "decline" }]);
  assert.deepEqual((await messages()).find(m => m.id === "legacy-approval")?.result, { decision: { denied: { rejection: "Phase 1 supports chat only" } } });
});

test("process crash fails the task once; next command reconnects and resumes", async t => {
  const { backend, messages } = await setup(t);
  await assert.rejects(backend.run("world", "crash", signal(), () => {}));
  assert.equal(await backend.run("world", "after-crash", signal(), () => {}), "fixture: after-crash");
  const requests = await messages();
  assert.equal(requests.filter(m => m.method === "initialize").length, 2);
  assert.equal(requests.filter(m => m.method === "turn/start" && m.params.input[0].text === "crash").length, 1);
  assert.equal(requests.filter(m => m.method === "thread/resume").length, 1);
});

test("cancellation during turn/start waits for turn id then interrupts", async t => {
  const { backend, messages } = await setup(t);
  const controller = new AbortController();
  await assert.rejects(backend.run("world", "slow-start", controller.signal, () => { setTimeout(() => controller.abort(), 10); }));
  assert.equal((await messages()).some(m => m.method === "turn/interrupt"), true);
  assert.equal(await backend.run("world", "next", signal(), () => {}), "fixture: next");
});

test("malformed stdout and RPC timeouts fail without hanging", async t => {
  const { backend } = await setup(t, { requestTimeoutMs: 250 });
  await assert.rejects(backend.run("world", "malformed", signal(), () => {}));
  await assert.rejects(backend.run("world", "hang", signal(), () => {}));
});

test("token creation is persistent, private and never accepts short credentials", async t => {
  const { dataDir } = await setup(t);
  const first = await loadToken(dataDir);
  assert.equal(first, await loadToken(dataDir));
  assert.equal(authenticated("Bearer " + first, first), true);
  assert.equal(authenticated("Bearer wrong", first), false);
  await assert.rejects(loadToken(dataDir, "short"));
  assert.throws(() => configSchema.parse({ host: "0.0.0.0" }));
});

for (const [scenario, method] of [["hang-initialize", "initialize"], ["hang-config", "config/read"], ["hang-thread", "thread/start"], ["hang-resume", "thread/resume"]]) {
  test(`cancellation terminates a process stuck in ${method}`, async t => {
    const { backend, log } = await setup(t, { requestTimeoutMs: 10000 }, scenario);
    if (scenario === "hang-resume") await backend.run("world", "first", signal(), () => {});
    const controller = new AbortController();
    const pending = backend.run("world", "cancel", controller.signal, () => {});
    const rejected = assert.rejects(pending);
    await until(() => existsSync(log) && readFileSync(log, "utf8").includes(`"method":"${method}"`));
    const pid = Number(await readFile(log + ".pid", "utf8"));
    const started = Date.now();
    controller.abort();
    await rejected;
    assert(Date.now() - started < 3000);
    assert.throws(() => process.kill(pid, 0));
  });
}

test("closing the backend does not wait for a stalled initialization timeout", async t => {
  const { backend, log } = await setup(t, { requestTimeoutMs: 10000 }, "hang-initialize");
  const rejected = assert.rejects(backend.run("world", "start", signal(), () => {}));
  await until(() => existsSync(log));
  const started = Date.now();
  await Promise.all([backend.close(), backend.close(), rejected]);
  assert(Date.now() - started < 3000);
});

test("failed thread resume does not trap later commands in the same stale thread", async t => {
  const { backend, messages } = await setup(t, {}, "reject-resume");
  await backend.run("world", "first", signal(), () => {});
  await assert.rejects(backend.run("world", "failed-resume", signal(), () => {}));
  assert.equal(await backend.run("world", "new-thread", signal(), () => {}), "fixture: new-thread");
  assert.equal((await messages()).filter(m => m.method === "thread/start").length, 2);
  assert.equal((await messages()).filter(m => m.method === "turn/start").length, 2);
});
