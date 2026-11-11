import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { configSchema } from "../src/config.js";
import { TaskHistory } from "../src/task-history.js";
import { TaskManager } from "../src/task-manager.js";
import { MockBackend } from "../src/backend.js";
import { startGateway } from "../src/server.js";
import { envelope } from "@mccodex/shared";
import type { TaskSnapshot } from "@mccodex/shared";
import { connect, until } from "./helpers.js";

const options = configSchema.parse({}).history;
const makeTask = (status: TaskSnapshot["status"] = "RUNNING"): TaskSnapshot => ({ id: "task-" + randomUUID(), worldSessionId: "world", text: "private prompt must never enter history", status, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), result: "secret result", error: "credential-like raw error" });
async function temp(t: any) { const dir = await mkdtemp(path.join(os.tmpdir(), "history-test-")); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test("journal stores only metadata and recovers abandoned tasks without reconstructing approvals", async t => {
  const dir = await temp(t), history = new TaskHistory(dir, options);
  const task = makeTask("BUILDING");
  history.record(task);
  const raw = await readFile(history.file, "utf8");
  for (const forbidden of [task.text, task.result!, task.error!, "Authorization", "token"]) assert.equal(raw.includes(forbidden), false);
  const recovered = new TaskHistory(dir, options);
  assert.equal(recovered.recent()[0]?.status, "INTERRUPTED");
  assert.equal(recovered.recent()[0]?.writeStarted, true);
  assert.equal(recovered.status().recovered, 1);
  assert.match(recovered.describe(), /不恢复审批/);
  const manager = new TaskManager(new MockBackend(), 10, () => {}, () => {});
  await manager.setWorld("world");
  assert.throws(() => manager.approve("world", task.id));
  await manager.close();
  if (process.platform !== "win32") assert.equal((await stat(history.file)).mode & 0o777, 0o600);
});

test("recovers an incomplete final line, but rejects a corrupt committed record", async t => {
  const dir = await temp(t), history = new TaskHistory(dir, options);
  history.record(makeTask("COMPLETED"));
  await appendFile(history.file, '{"version":');
  const recovered = new TaskHistory(dir, options);
  assert.equal(recovered.recent().length, 1);
  assert.equal((await readFile(history.file, "utf8")).endsWith("\n"), true);
  await appendFile(history.file, "{broken}\n");
  assert.throws(() => new TaskHistory(dir, options), /损坏记录/);
});

test("rotation and the in-memory index remain bounded", async t => {
  const dir = await temp(t), config = { ...options, maxBytes: 4096, maxFiles: 2, maxEntries: 5 };
  const history = new TaskHistory(dir, config);
  for (let index = 0; index < 80; index++) history.record(makeTask("COMPLETED"));
  assert.equal(history.recent().length, 5);
  const files = await readdir(path.dirname(history.file));
  assert(files.length <= 2);
  for (const file of files) assert((await stat(path.join(path.dirname(history.file), file))).size <= 4096);
  assert.equal(new TaskHistory(dir, config).recent().length, 5);
});

test("history I/O failure is observable and does not break task execution", async t => {
  const dir = await temp(t), history = new TaskHistory(dir, options);
  const journalDir = path.dirname(history.file);
  await rename(journalDir, journalDir + "-saved");
  await writeFile(journalDir, "not a directory");
  const manager = new TaskManager(new MockBackend(1), 10, () => {}, () => {}, task => history.record(task));
  await manager.setWorld("world");
  manager.submit("world", "task");
  await until(() => manager.list("world")[0]?.status === "COMPLETED");
  assert.equal(history.status().healthy, false);
  assert.throws(() => history.recent(), /写入故障/);
  await manager.close();
});

test("Gateway history survives restart; shutdown closes partial HTTP connections and is idempotent", async t => {
  const dir = await temp(t), config = configSchema.parse({ port: 0, dataDir: dir }), token = "history-test-" + "x".repeat(32);
  const gateway = await startGateway(config, token, new MockBackend(1));
  let current = gateway;
  t.after(() => current.close());
  const client = await connect(gateway.url, token);
  client.send(envelope("client.ready", { worldSessionId: "first" }));
  client.send(envelope("chat.command", { worldSessionId: "first", text: "@codex local history test" }));
  await until(() => client.messages.some(m => m.type === "task.completed"));
  const id = gateway.manager.list("first")[0]!.id;
  const stalled = createConnection(gateway.port, "127.0.0.1");
  stalled.on("error", () => {});
  await new Promise<void>(resolve => stalled.once("connect", resolve));
  stalled.write("GET /health HTTP/1.1\r\n");
  const start = Date.now();
  await Promise.all([gateway.close(), gateway.close()]);
  assert(Date.now() - start < 3000);
  stalled.destroy();
  current = await startGateway(config, token, new MockBackend());
  const reconnected = await connect(current.url, token);
  t.after(() => reconnected.socket.terminate());
  reconnected.send(envelope("client.ready", { worldSessionId: "second" }));
  reconnected.send(envelope("chat.command", { worldSessionId: "second", text: "!codex history 5" }));
  await until(() => reconnected.messages.some(m => m.type === "chat.message" && m.payload.text.includes(id)));
  assert.equal(current.manager.list("second").length, 0);
  assert.throws(() => current.manager.approve("second", id));
});
