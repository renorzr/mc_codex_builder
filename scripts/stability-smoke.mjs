import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { envelope } from "../packages/shared/dist/index.js";

// Real Gateway processes, synthetic app-server/world only. No inference or Minecraft access.
const dir = await mkdtemp(path.join(os.tmpdir(), "mccodex-stability-"));
const token = randomBytes(32).toString("hex");
const log = path.join(dir, "rpc.jsonl");
const config = path.join(dir, "gateway.json");
await writeFile(config, JSON.stringify({ backend: "codex", port: 0, dataDir: dir,
  building: { enabled: true }, world: { enabled: true, mcpServerPath: path.resolve("packages/gateway/test/fixtures/mcpfabric.mjs") },
  codex: { command: process.execPath, args: [path.resolve("packages/gateway/test/fixtures/app-server.mjs"), log, "build-good"] },
}));
let child, childClosed, socket;
const messages = [];
const until = async predicate => {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Stability smoke timed out");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
async function launch() {
  let ready, output = "";
  child = spawn(process.execPath, [path.resolve("packages/gateway/dist/index.js")], {
    env: { ...process.env, GATEWAY_CONFIG: config, GATEWAY_BACKEND: "codex", GATEWAY_PORT: "0", GATEWAY_DATA_DIR: dir, GATEWAY_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
  });
  childClosed = once(child, "close");
  child.stderr.resume();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    output += chunk;
    let end;
    while ((end = output.indexOf("\n")) !== -1) {
      const line = output.slice(0, end); output = output.slice(end + 1);
      try { const value = JSON.parse(line); if (value.ready) ready = value; } catch {}
    }
  });
  await until(() => ready || child.exitCode !== null);
  assert(ready, "Gateway exited before becoming ready");
  messages.length = 0;
  socket = new WebSocket(ready.url, { headers: { Authorization: "Bearer " + token } });
  socket.on("message", data => messages.push(JSON.parse(data.toString())));
  await once(socket, "open");
  socket.send(JSON.stringify(envelope("client.ready", { worldSessionId: "crash-smoke" })));
  await until(() => messages.some(message => message.type === "client.registered"));
}
const send = text => socket.send(JSON.stringify(envelope("chat.command", { worldSessionId: "crash-smoke", text })));
try {
  await launch();
  send("@codex 模拟世界规划四格石砖，等待确认");
  await until(() => messages.some(message => message.type === "task.approval_required"));
  const taskId = messages.find(message => message.type === "task.approval_required").payload.task.id;
  child.kill("SIGKILL"); // Deliberately terminate only this test's Gateway child.
  await childClosed;
  socket.terminate();
  // Its stdio fixture must also exit when the Gateway's pipe closes.
  const fixturePid = Number(await readFile(log + ".pid", "utf8"));
  await until(() => { try { process.kill(fixturePid, 0); return false; } catch { return true; } });
  await launch();
  send("!codex history 5");
  await until(() => messages.some(message => message.type === "chat.message" && message.payload.text.includes(taskId) && message.payload.text.includes("INTERRUPTED")));
  const approval = envelope("chat.command", { worldSessionId: "crash-smoke", text: "!codex approve " + taskId });
  socket.send(JSON.stringify(approval));
  await until(() => messages.some(message => message.type === "command.error" && message.payload.replyTo === approval.messageId));
  assert.equal(messages.some(message => message.type === "task.approval_required"), false);
  const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.filter(call => call.method === "turn/start").length, 1, "Restart replayed a turn");
  assert.equal(calls.filter(call => call.method === "mcpServer/tool/call" && ["set_block", "fill_blocks"].includes(call.params.tool)).length, 0);
  console.log(JSON.stringify({ ok: true, data: "synthetic fixture, no Minecraft", forcedGatewayCrash: true, recoveredStatus: "INTERRUPTED", oldApprovalRejected: true, replayedTurns: 0, writes: 0 }));
} finally {
  socket?.terminate();
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await childClosed; } finally { clearTimeout(timer); }
  }
  await rm(dir, { recursive: true, force: true });
}
