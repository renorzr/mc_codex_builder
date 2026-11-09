import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { envelope } from "@mccodex/shared";
import type { ServerMessage } from "@mccodex/shared";
import { MockBackend } from "./backend.js";
import { CodexBackend } from "./codex/backend.js";
import { configSchema } from "./config.js";
import { startGateway } from "./server.js";

const real = process.argv.includes("--codex");
const dataDir = await mkdtemp(path.join(os.tmpdir(), "mccodex-smoke-"));
const config = configSchema.parse({ port: 0, backend: real ? "codex" : "mock", dataDir });
// Use a fresh token and ephemeral server; no persistent configuration is changed.
const token = randomBytes(32).toString("hex");
const runningBackend = real ? new CodexBackend(config) : new MockBackend();
const running = await startGateway(config, token, runningBackend);
const client = new WebSocket(running.url, { headers: { Authorization: "Bearer " + token } });
const received: ServerMessage[] = [];
const waiting = new Set<() => void>();
client.on("message", data => { received.push(JSON.parse(data.toString())); for (const check of waiting) check(); });
const wait = (predicate: (message: ServerMessage) => boolean) => new Promise<ServerMessage>((resolve, reject) => {
  const timeout = setTimeout(() => { waiting.delete(check); reject(new Error("smoke timeout")); }, real ? 180000 : 5000);
  const check = () => {
    const message = received.find(predicate);
    if (message) { clearTimeout(timeout); waiting.delete(check); resolve(message); }
  };
  waiting.add(check); check();
});
try {
  await new Promise<void>((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });
  const world = randomUUID();
  client.send(JSON.stringify(envelope("client.ready", { worldSessionId: world })));
  await wait(message => message.type === "client.registered");
  let count = 0;
  for (const text of ["@codex 请只用一句中文介绍你自己，不要调用任何工具。", "@codex 请简短说明当前能否读取 Minecraft 世界，不要调用任何工具。"] ) {
    const command = envelope("chat.command", { worldSessionId: world, text });
    client.send(JSON.stringify(command));
    const ack = await wait(message => message.type === "command.accepted" && message.payload.replyTo === command.messageId);
    assert.equal(ack.type, "command.accepted");
    const taskId = ack.type === "command.accepted" ? ack.payload.taskId : undefined;
    const done = await wait(message => (message.type === "task.completed" || message.type === "task.failed") && message.payload.task.id === taskId);
    if (done.type === "task.failed") throw new Error(done.payload.task.error);
    count++;
  }
  console.log(JSON.stringify({ ok: true, backend: runningBackend.kind, completed: count, replies: received.filter(m => m.type === "chat.message").map(m => m.payload.text) }, null, 2));
} finally {
  client.terminate();
  await running.close();
  await rm(dataDir, { recursive: true, force: true });
}
