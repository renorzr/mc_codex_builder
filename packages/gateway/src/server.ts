import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { clientMessageSchema, envelope, MAX_MESSAGE_BYTES, parseChatCommand } from "@mccodex/shared";
import type { ClientMessage, ServerMessage, ServerPayloads, TaskSnapshot } from "@mccodex/shared";
import type { Backend } from "./backend.js";
import { authenticated } from "./config.js";
import type { GatewayConfig } from "./config.js";
import { TaskManager } from "./task-manager.js";

const help = "@codex <任务>；!codex status；!codex queue；!codex stop [task-id]；!codex help。当前仅支持聊天，建造与 approve/reject 尚未开放。";

export async function startGateway(config: GatewayConfig, token: string, backend: Backend) {
  let socket: WebSocket | undefined;
  let world: string | undefined;
  let stopping = false;
  let lifecycle: Promise<void> = Promise.resolve();
  const receipts = new Map<string, { fingerprint: string; response: ServerMessage[] }>();
  const sendTo = (client: WebSocket, message: ServerMessage) => {
    if (client.readyState !== WebSocket.OPEN) return;
    if (client.bufferedAmount > 1024 * 1024) { client.close(1008, "Slow consumer"); return; }
    const serialized = JSON.stringify(message);
    if (Buffer.byteLength(serialized) > MAX_MESSAGE_BYTES) {
      client.send(JSON.stringify(envelope("command.error", { code: "RESPONSE_TOO_LARGE", message: "回复超过 64 KiB，请缩小请求范围" })));
    } else client.send(serialized);
  };
  const publish = <K extends keyof ServerPayloads>(type: K, payload: ServerPayloads[K]) => {
    if (socket) sendTo(socket, envelope(type, payload) as ServerMessage);
  };
  const manager = new TaskManager(backend, config.maxTasks, (task: TaskSnapshot) => {
    if (task.worldSessionId !== world) return;
    if (task.status === "COMPLETED") publish("task.completed", { task });
    else if (task.status === "FAILED") publish("task.failed", { task });
    else publish("task.status", { task });
  }, (task, text) => {
    if (task.worldSessionId === world) publish("chat.message", { taskId: task.id, text });
  });

  const http = createServer((req, res) => {
    if (!authenticated(req.headers.authorization, token) || req.headers.origin) {
      res.writeHead(401).end(); return;
    }
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, backend: backend.kind, writesEnabled: false }));
    } else res.writeHead(404).end();
  });
  const ws = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
  http.on("upgrade", (req, netSocket, head) => {
    const allowedHost = req.headers.host === `127.0.0.1:${(http.address() as AddressInfo).port}`;
    let status: number | undefined;
    if (stopping) status = 503;
    else if (!authenticated(req.headers.authorization, token)) status = 401;
    else if (req.headers.origin || !allowedHost) status = 403;
    else if (req.url !== "/ws") status = 404;
    else if (socket && socket.readyState !== WebSocket.CLOSED) status = 409;
    if (status) { netSocket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return; }
    ws.handleUpgrade(req, netSocket, head, client => ws.emit("connection", client));
  });

  ws.on("connection", (client: WebSocket) => {
    socket = client;
    let clientWorld: string | undefined;
    let alive = true;
    let pendingMessages = 0;
    let chain = Promise.resolve();
    const heartbeat = setInterval(() => {
      if (!alive) { client.terminate(); return; }
      alive = false;
      client.ping();
    }, config.heartbeatMs);
    client.on("pong", () => { alive = true; });
    client.on("error", () => client.terminate());
    sendTo(client, envelope("gateway.hello", { backend: backend.kind, writesEnabled: false }));

    async function handle(message: ClientMessage) {
      if (client.readyState !== WebSocket.OPEN) return;
      if (message.type === "ping") { sendTo(client, envelope("pong", {})); return; }
      if (message.type === "client.ready") {
        const next = message.payload.worldSessionId;
        if (clientWorld !== next) {
          world = undefined;
          lifecycle = lifecycle.then(() => manager.setWorld(next));
          await lifecycle;
          if (client.readyState !== WebSocket.OPEN) return;
          world = clientWorld = next;
        }
        sendTo(client, envelope("client.registered", { worldSessionId: next }));
        return;
      }
      if (!clientWorld || message.payload.worldSessionId !== clientWorld) throw new Error("请先发送 client.ready，且命令必须属于当前世界会话");
      if (message.type === "client.goodbye") {
        world = clientWorld = undefined;
        lifecycle = lifecycle.then(() => manager.setWorld(undefined));
        await lifecycle;
        return;
      }
      const key = clientWorld + ":" + message.messageId;
      const fingerprint = JSON.stringify(message);
      const cached = receipts.get(key);
      if (cached) {
        if (cached.fingerprint !== fingerprint) throw new Error("相同 messageId 不能用于不同消息");
        const ack = cached.response.find(response => response.type === "command.accepted" && response.payload.taskId);
        if (ack?.type === "command.accepted") {
          const task = manager.list(clientWorld).find(task => task.id === ack.payload.taskId);
          if (!task) {
            sendTo(client, envelope("command.error", { replyTo: message.messageId, code: "RESULT_EXPIRED", message: "该指令已处理，但会话或任务记录已结束；不会重新执行" }));
            return;
          }
          sendTo(client, ack);
          const type = task.status === "COMPLETED" ? "task.completed" : task.status === "FAILED" ? "task.failed" : "task.status";
          sendTo(client, envelope(type, { task }));
        } else for (const response of cached.response) sendTo(client, response);
        return;
      }
      const response: ServerMessage[] = [];
      const reply = <K extends keyof ServerPayloads>(type: K, payload: ServerPayloads[K]) => {
        const result = envelope(type, payload) as ServerMessage;
        response.push(result);
        sendTo(client, result);
      };
      try {
        const command = parseChatCommand(message.payload.text);
        if (command.kind === "task") {
          const task = manager.submit(clientWorld, command.text);
          reply("command.accepted", { replyTo: message.messageId, taskId: task.id });
          reply("task.status", { task });
        } else {
          switch (command.kind) {
            case "help": reply("chat.message", { text: help }); break;
            case "status": {
              const active = manager.current(clientWorld);
              reply("chat.message", { text: active ? `${active.id} ${active.status}` : "当前没有运行中的任务。" }); break;
            }
            case "queue": {
              const queued = manager.list(clientWorld).filter(task => ["QUEUED", "RUNNING", "CANCELLING"].includes(task.status));
              reply("chat.message", { text: queued.length ? queued.map(task => `${task.id} ${task.status}`).join("\n") : "队列为空。" }); break;
            }
            case "stop": manager.cancel(clientWorld, command.taskId); break;
            case "approve": case "reject": throw new Error("当前仅支持聊天，没有可审批的建筑计划；不会执行世界写入");
          }
          reply("command.accepted", { replyTo: message.messageId });
        }
      } catch (error) {
        reply("command.error", { replyTo: message.messageId, code: "COMMAND_REJECTED", message: error instanceof Error ? error.message : "指令失败" });
      }
      receipts.set(key, { fingerprint, response });
      if (receipts.size > 1024) receipts.delete(receipts.keys().next().value!);
    }

    client.on("message", (data, binary) => {
      if (++pendingMessages > 64) { client.close(1008, "Too many pending messages"); return; }
      chain = chain.then(async () => {
        if (binary) throw new Error("仅接受 JSON 文本消息");
        const parsed = clientMessageSchema.safeParse(JSON.parse(data.toString()));
        if (!parsed.success) throw new Error("消息格式或 protocolVersion 无效");
        await handle(parsed.data);
      }).catch(error => {
        sendTo(client, envelope("command.error", { code: "INVALID_MESSAGE", message: error instanceof SyntaxError ? "JSON 格式错误" : error.message }));
      }).finally(() => { pendingMessages--; });
    });
    client.on("close", () => {
      clearInterval(heartbeat);
      if (socket === client) {
        socket = undefined;
        world = undefined;
        lifecycle = lifecycle.then(() => manager.setWorld(undefined));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(config.port, config.host, () => { http.off("error", reject); resolve(); });
  });
  const port = (http.address() as AddressInfo).port;
  return {
    port, url: `ws://127.0.0.1:${port}/ws`, manager,
    async close() {
      stopping = true;
      socket?.terminate();
      await lifecycle;
      await manager.close();
      await new Promise<void>(resolve => ws.close(() => resolve()));
      await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    },
  };
}
