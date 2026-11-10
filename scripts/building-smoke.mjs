import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import { WebSocket } from "ws";
import { envelope } from "../packages/shared/dist/index.js";
import { configSchema } from "../packages/gateway/dist/config.js";
import { CodexBackend } from "../packages/gateway/dist/codex/backend.js";
import { startGateway } from "../packages/gateway/dist/server.js";

const model = process.argv.includes("--model");
const dir = await mkdtemp(path.join(os.tmpdir(), "mccodex-build-smoke-"));
const logFile = path.join(dir, "rpc.jsonl");
const stateFile = path.join(dir, "world.json");
const mcpLog = path.join(dir, "mcp.jsonl");
const wrapper = path.join(dir, "mcp-fixture.mjs");
await writeFile(wrapper, `process.env.MCCODEX_FIXTURE_STATE = ${JSON.stringify(stateFile)}; process.env.MCCODEX_FIXTURE_LOG = ${JSON.stringify(mcpLog)}; await import(${JSON.stringify(pathToFileURL(path.resolve("packages/gateway/test/fixtures/mcpfabric.mjs")).href)});\n`);
const config = configSchema.parse({ port: 0, backend: "codex", dataDir: dir, building: { enabled: true },
  world: { enabled: true, mcpServerPath: wrapper },
  ...(!model ? { codex: { command: process.execPath, args: [path.resolve("packages/gateway/test/fixtures/app-server.mjs"), logFile, "build-good"] } } : {}),
});
const token = randomBytes(32).toString("hex");
const gateway = await startGateway(config, token, new CodexBackend(config));
const socket = new WebSocket(gateway.url, { headers: { Authorization: "Bearer " + token } });
const messages = [];
socket.on("message", data => messages.push(JSON.parse(data.toString())));
const wait = async predicate => {
  const deadline = Date.now() + 180000;
  while (!messages.some(predicate)) {
    if (Date.now() > deadline) throw new Error("Building smoke timed out");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return messages.find(predicate);
};
try {
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  socket.send(JSON.stringify(envelope("client.ready", { worldSessionId: "smoke-world" })));
  await wait(message => message.type === "client.registered");
  socket.send(JSON.stringify(envelope("chat.command", { worldSessionId: "smoke-world", text: "@codex 这是模拟测试世界，所有方块是空气。请规划在 (12,65,20) 到 (13,66,20) 填充四格石砖的小柱，必须等我确认。" })));
  const planned = await wait(message => message.type === "task.approval_required" || message.type === "task.failed");
  assert.equal(planned.type, "task.approval_required", planned.payload.task.error);
  assert.equal(planned.payload.task.build.changedBlocks, 4);
  const before = await readFile(model ? mcpLog : logFile, "utf8");
  const isWrite = line => {
    const value = JSON.parse(line);
    return (value.method === "tools/call" && ["set_block", "fill_blocks"].includes(value.params.name)) || (value.method === "mcpServer/tool/call" && ["set_block", "fill_blocks"].includes(value.params.tool));
  };
  assert.equal(before.trim().split("\n").filter(isWrite).length, 0);
  const taskId = planned.payload.task.id;
  const approve = envelope("chat.command", { worldSessionId: "smoke-world", text: "!codex approve " + taskId });
  socket.send(JSON.stringify(approve));
  socket.send(JSON.stringify(approve)); // Retrying the same message must not repeat writes.
  const done = await wait(message => ["task.completed", "task.failed"].includes(message.type) && message.payload.task.id === taskId);
  assert.equal(done.type, "task.completed", done.payload.task.error);
  const after = await readFile(model ? mcpLog : logFile, "utf8");
  assert.equal(after.trim().split("\n").filter(isWrite).length, 2);
  if (model) {
    const world = JSON.parse(await readFile(stateFile, "utf8"));
    for (const pos of ["12,65,20", "13,65,20", "12,66,20", "13,66,20"]) assert.equal(world[pos], "minecraft:stone_bricks");
    assert.equal(Object.keys(world).length, 4);
  }
  console.log(JSON.stringify({ ok: true, data: "synthetic fixture, no Minecraft", realModel: model, writesBeforeApproval: 0, writeBatchesAfterApproval: 2, verifiedCells: 4, duplicateApprovalRepeatedWrites: false, result: done.payload.task.result }, null, 2));
} finally {
  socket.terminate();
  await gateway.close();
  await rm(dir, { recursive: true, force: true });
}
