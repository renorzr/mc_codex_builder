import { randomUUID } from "node:crypto";
import { z } from "zod";
export * from "./build-plan.js";
import type { BuildSummary } from "./build-plan.js";

export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 64 * 1024;

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
const header = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  messageId: z.uuid(),
  timestamp: z.iso.datetime({ offset: true }),
};
// worldSessionId is a connection-lifetime nonce, never an authoritative world identity.
export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ ...header, type: z.literal("client.ready"), payload: z.object({ worldSessionId: id }).strict() }).strict(),
  z.object({ ...header, type: z.literal("chat.command"), payload: z.object({ worldSessionId: id, text: z.string().trim().min(1).max(8000) }).strict() }).strict(),
  z.object({ ...header, type: z.literal("client.goodbye"), payload: z.object({ worldSessionId: id }).strict() }).strict(),
  z.object({ ...header, type: z.literal("ping"), payload: z.object({}).strict() }).strict(),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type TaskStatus = "QUEUED" | "RUNNING" | "AWAITING_APPROVAL" | "BUILDING" | "VERIFYING" | "CANCELLING" | "COMPLETED" | "FAILED" | "CANCELLED";
export interface TaskSnapshot {
  id: string;
  worldSessionId: string;
  text: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  result?: string;
  error?: string;
  build?: BuildSummary;
}
export interface ServerPayloads {
  "gateway.hello": { backend: "mock" | "codex"; writesEnabled: boolean; mode?: "chat" | "observe" | "build" };
  "client.registered": { worldSessionId: string };
  "command.accepted": { replyTo: string; taskId?: string };
  "task.status": { task: TaskSnapshot };
  "task.completed": { task: TaskSnapshot };
  "task.failed": { task: TaskSnapshot };
  "task.approval_required": { task: TaskSnapshot };
  "chat.message": { text: string; taskId?: string };
  "command.error": { replyTo?: string; code: string; message: string };
  pong: Record<string, never>;
}
export type ServerMessage = { [K in keyof ServerPayloads]: {
  protocolVersion: 1;
  messageId: string;
  timestamp: string;
  type: K;
  payload: ServerPayloads[K];
} }[keyof ServerPayloads];

export function envelope<K extends string, P>(type: K, payload: P): { protocolVersion: 1; messageId: string; timestamp: string; type: K; payload: P } {
  return { protocolVersion: PROTOCOL_VERSION, messageId: randomUUID(), timestamp: new Date().toISOString(), type, payload };
}

export type ChatCommand =
  | { kind: "task"; text: string }
  | { kind: "status" | "queue" | "help" }
  | { kind: "history"; limit: number }
  | { kind: "stop"; taskId?: string }
  | { kind: "approve" | "reject"; taskId?: string };

export function parseChatCommand(text: string): ChatCommand {
  const task = /^@codex(?:\s+(.*))?$/isu.exec(text);
  if (task) {
    if (!task[1]?.trim()) throw new Error("用法：@codex <任务>");
    return { kind: "task", text: task[1].trim() };
  }
  const control = /^!codex(?:\s+(.*))?$/isu.exec(text);
  if (!control) throw new Error("指令必须以 @codex 或 !codex 开头");
  const [verb = "help", ...args] = (control[1] ?? "").trim().split(/\s+/);
  switch (verb.toLowerCase()) {
    case "history": {
      if (args.length > 1 || (args[0] && !/^(?:[1-9]|[1-4][0-9]|50)$/.test(args[0]))) throw new Error("用法：!codex history [1-50]");
      return { kind: "history", limit: args[0] ? Number(args[0]) : 10 };
    }
    case "status": case "queue": case "help":
      if (args.length) throw new Error("该命令不接受参数");
      return { kind: verb.toLowerCase() as "status" | "queue" | "help" };
    case "stop":
      if (args.length > 1 || (args[0] && !id.safeParse(args[0]).success)) throw new Error("用法：!codex stop [task-id]");
      return { kind: "stop", taskId: args[0] };
    case "approve": case "reject":
      if (args.length > 1 || (args[0] && !id.safeParse(args[0]).success)) throw new Error("用法：!codex " + verb + " [task-id]");
      return { kind: verb.toLowerCase() as "approve" | "reject", taskId: args[0] };
    default: throw new Error("未知控制命令，输入 !codex help 查看帮助");
  }
}

export function renderServerMessage(message: ServerMessage): string | undefined {
  switch (message.type) {
    case "gateway.hello": return `[Codex] 已连接（${message.payload.backend}，${message.payload.mode === "build" ? "建造需逐任务确认" : message.payload.mode === "observe" ? "世界观察，只读" : "仅聊天"}）。`;
    case "chat.message": return `[Codex] ${message.payload.text}`;
    case "task.status": return `[Codex] ${message.payload.task.id} ${message.payload.task.status}`;
    case "task.failed": return `[Codex] 任务失败：${message.payload.task.error}`;
    case "command.error": return `[Codex] ${message.payload.message}`;
  }
}
