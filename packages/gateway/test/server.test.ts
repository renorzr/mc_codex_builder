import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { envelope } from "@mccodex/shared";
import { MockBackend } from "../src/backend.js";
import { configSchema } from "../src/config.js";
import { startGateway } from "../src/server.js";
import { connect, rejected, until } from "./helpers.js";

const token = "local-test-token-" + "x".repeat(32);
test("requires bearer auth, rejects browser origins, and reserves one companion", async t => {
  const gateway = await startGateway(configSchema.parse({ history: { enabled: false }, port: 0 }), token, new MockBackend());
  t.after(() => gateway.close());
  assert.equal((await fetch(`http://127.0.0.1:${gateway.port}/health`)).status, 401);
  const health = await fetch(`http://127.0.0.1:${gateway.port}/health`, { headers: { Authorization: "Bearer " + token } });
  assert.deepEqual(await health.json(), { ok: true, backend: "mock", mode: "chat", writesEnabled: false, history: { enabled: false, healthy: true, recovered: 0, retainedEntries: 0 } });
  await rejected(gateway.url, "wrong-token", 401);
  await rejected(gateway.url, token, 403, { Origin: "http://evil.example" });
  const client = await connect(gateway.url, token);
  t.after(() => client.socket.terminate());
  await rejected(gateway.url, token, 409);
});

test("bad frames do not crash server; identical command retries create exactly one task", async t => {
  const gateway = await startGateway(configSchema.parse({ history: { enabled: false }, port: 0 }), token, new MockBackend());
  t.after(() => gateway.close());
  const client = await connect(gateway.url, token);
  t.after(() => client.socket.terminate());
  client.socket.send("{broken");
  client.send({ ...envelope("ping", {}), protocolVersion: 99 });
  await until(() => client.messages.filter(m => m.type === "command.error").length === 2);
  client.send(envelope("client.ready", { worldSessionId: "world-a" }));
  const command = envelope("chat.command", { worldSessionId: "world-a", text: "@codex 你好" });
  client.send(command); client.send(command);
  await until(() => client.messages.some(m => m.type === "task.completed"));
  assert.equal(gateway.manager.list("world-a").length, 1);
  const acks = client.messages.filter(m => m.type === "command.accepted");
  assert.equal(acks.length, 2);
  assert.deepEqual(acks[0], acks[1]);
  const completedCount = client.messages.filter(m => m.type === "task.completed").length;
  client.send(command);
  await until(() => client.messages.filter(m => m.type === "task.completed").length > completedCount);
  client.send({ ...command, payload: { ...command.payload, text: "@codex changed" } });
  await until(() => client.messages.filter(m => m.type === "command.error").length === 3);
  assert.equal(gateway.manager.list("world-a").length, 1);
});

test("world change cancels active and queued work, rejects stale messages, starts fresh", async t => {
  const gateway = await startGateway(configSchema.parse({ history: { enabled: false }, port: 0 }), token, new MockBackend(1000));
  t.after(() => gateway.close());
  const client = await connect(gateway.url, token);
  t.after(() => client.socket.terminate());
  client.send(envelope("client.ready", { worldSessionId: "old" }));
  client.send(envelope("chat.command", { worldSessionId: "old", text: "@codex first" }));
  client.send(envelope("chat.command", { worldSessionId: "old", text: "@codex second" }));
  await until(() => gateway.manager.current("old")?.status === "RUNNING");
  client.send(envelope("client.ready", { worldSessionId: "new" }));
  await until(() => client.messages.some(m => m.type === "client.registered" && m.payload.worldSessionId === "new"));
  assert.equal(gateway.manager.list("old").length, 0);
  client.send(envelope("chat.command", { worldSessionId: "old", text: "@codex stale" }));
  await until(() => client.messages.some(m => m.type === "command.error"));
  assert.equal(client.messages.some(m => m.type === "task.completed"), false);
  client.send(envelope("chat.command", { worldSessionId: "new", text: "!codex help" }));
  await until(() => client.messages.some(m => m.type === "chat.message" && m.payload.text.includes("!codex status")));
});

test("stops running and queued tasks; disconnect cancels work and permits reconnect", async t => {
  const gateway = await startGateway(configSchema.parse({ history: { enabled: false }, port: 0 }), token, new MockBackend(1000));
  t.after(() => gateway.close());
  const client = await connect(gateway.url, token);
  const world = randomUUID();
  client.send(envelope("client.ready", { worldSessionId: world }));
  for (let i = 0; i < 2; i++) client.send(envelope("chat.command", { worldSessionId: world, text: "@codex task " + i }));
  await until(() => gateway.manager.list(world).length === 2);
  const queued = gateway.manager.list(world).find(t => t.status === "QUEUED")!;
  client.send(envelope("chat.command", { worldSessionId: world, text: "!codex stop " + queued.id }));
  client.send(envelope("chat.command", { worldSessionId: world, text: "!codex stop" }));
  await until(() => gateway.manager.list(world).every(t => t.status === "CANCELLED"));
  client.send(envelope("chat.command", { worldSessionId: world, text: "@codex cancel-on-disconnect" }));
  await until(() => gateway.manager.current(world));
  client.socket.terminate();
  await until(() => gateway.manager.list(world).length === 0);
  const reconnected = await connect(gateway.url, token);
  t.after(() => reconnected.socket.terminate());
  reconnected.send(envelope("client.ready", { worldSessionId: "rejoined" }));
  await until(() => reconnected.messages.some(m => m.type === "client.registered"));
});

test("queue limit and unimplemented approvals return explicit errors", async t => {
  const gateway = await startGateway(configSchema.parse({ history: { enabled: false }, port: 0, maxTasks: 1 }), token, new MockBackend(1000));
  t.after(() => gateway.close());
  const client = await connect(gateway.url, token);
  t.after(() => client.socket.terminate());
  client.send(envelope("client.ready", { worldSessionId: "limit" }));
  for (const text of ["@codex first", "@codex second", "!codex approve task-123"]) client.send(envelope("chat.command", { worldSessionId: "limit", text }));
  await until(() => client.messages.filter(m => m.type === "command.error").length === 2);
  assert.equal(gateway.manager.list("limit").length, 1);
});
