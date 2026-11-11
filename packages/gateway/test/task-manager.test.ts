import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { TaskManager } from "../src/task-manager.js";
import type { Backend } from "../src/backend.js";
import { until } from "./helpers.js";

test("serial queue waits for cancellation cleanup before starting the next task", async t => {
  const events: string[] = [];
  let concurrent = 0;
  const backend: Backend = {
    kind: "mock",
    async run(_world, text, signal) {
      concurrent++;
      assert.equal(concurrent, 1);
      events.push("start:" + text);
      try {
        if (text === "one") await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
        await delay(30);
        return text;
      } finally { concurrent--; events.push("end:" + text); }
    },
    async reset() {}, async close() {},
  };
  const manager = new TaskManager(backend, 10, () => {}, () => {});
  t.after(() => manager.close());
  await manager.setWorld("world");
  const first = manager.submit("world", "one");
  manager.submit("world", "two");
  await until(() => events.length === 1);
  manager.cancel("world", first.id);
  await until(() => manager.list("world").some(task => task.status === "COMPLETED"));
  assert.deepEqual(events, ["start:one", "end:one", "start:two", "end:two"]);
});

test("a failed task does not stall the queue and completed history is bounded", async t => {
  const backend: Backend = { kind: "mock", async run(_world, text) { if (text === "fail") throw new Error("backend failed"); return text; }, async reset() {}, async close() {} };
  const manager = new TaskManager(backend, 2, () => {}, () => {});
  t.after(() => manager.close());
  await manager.setWorld("world");
  manager.submit("world", "fail");
  manager.submit("world", "ok");
  await until(() => manager.list("world").every(task => ["FAILED", "COMPLETED"].includes(task.status)));
  assert.equal(manager.list("world")[0]?.error, "backend failed");
  manager.submit("world", "next");
  assert.equal(manager.list("world").length, 2);
  assert.throws(() => manager.submit("stale", "bad"));
});

test("closing during disconnect waits for the already-running cancellation cleanup", async t => {
  const events: string[] = [];
  let finishRun: (() => void) | undefined;
  const backend: Backend = {
    kind: "mock",
    async run(_world, _text, signal) {
      await new Promise<void>(resolve => {
        signal.addEventListener("abort", () => { events.push("abort"); finishRun = resolve; }, { once: true });
        events.push("start");
      });
      events.push("finished");
      return "done";
    },
    async reset() {}, async close() { events.push("closed"); },
  };
  const manager = new TaskManager(backend, 10, () => {}, () => {});
  t.after(async () => { finishRun?.(); await manager.close(); });
  await manager.setWorld("world");
  manager.submit("world", "task");
  await until(() => events.includes("start"));
  const disconnected = manager.setWorld(undefined);
  const closing = manager.close();
  await delay(10);
  assert.deepEqual(events, ["start", "abort"]);
  finishRun!();
  await Promise.all([disconnected, closing]);
  assert.deepEqual(events, ["start", "abort", "finished", "closed"]);
});
