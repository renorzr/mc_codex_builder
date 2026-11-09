import { readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { envelope, renderServerMessage } from "@mccodex/shared";
import type { ServerMessage } from "@mccodex/shared";
import { loadConfig } from "./config.js";

const config = await loadConfig();
const token = process.env.GATEWAY_TOKEN ?? (await readFile(path.join(config.dataDir, "gateway-token"), "utf8")).trim();
const socket = new WebSocket(`ws://127.0.0.1:${config.port}/ws`, { headers: { Authorization: "Bearer " + token }, maxPayload: 64 * 1024 });
let world = randomUUID();
let ready = false;
const input = readline.createInterface({ input: process.stdin, output: process.stdout });
const register = () => {
  ready = false;
  socket.send(JSON.stringify(envelope("client.ready", { worldSessionId: world })));
};
socket.on("open", () => {
  console.log("输入 @codex <任务> 或 !codex help；/world 模拟切换世界；/quit 退出。");
  register();
});
socket.on("message", data => {
  const message = JSON.parse(data.toString()) as ServerMessage;
  if (message.type === "client.registered") ready = message.payload.worldSessionId === world;
  const text = renderServerMessage(message);
  if (text) console.log(text);
});
socket.on("error", () => { console.error("无法连接 Gateway，请先运行 npm run dev 并核对端口和 token。"); process.exitCode = 1; input.close(); });
socket.on("close", () => { ready = false; input.close(); });
input.on("line", line => {
  if (line === "/quit") { input.close(); return; }
  if (!ready) { console.log("Gateway 尚未就绪。"); return; }
  if (line === "/world") { world = randomUUID(); register(); return; }
  if (line.trim()) socket.send(JSON.stringify(envelope("chat.command", { worldSessionId: world, text: line })));
});
input.on("close", () => socket.close());
