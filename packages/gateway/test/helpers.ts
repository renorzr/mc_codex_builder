import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import type { ServerMessage } from "@mccodex/shared";

export async function until(predicate: () => unknown, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Test condition timed out");
    await delay(5);
  }
}

export async function connect(url: string, token: string) {
  const socket = new WebSocket(url, { headers: { Authorization: "Bearer " + token } });
  const messages: ServerMessage[] = [];
  socket.on("message", data => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  return { socket, messages, send: (message: object) => socket.send(JSON.stringify(message)) };
}

export async function rejected(url: string, token: string, status: number, headers: Record<string, string> = {}) {
  const socket = new WebSocket(url, { headers: { Authorization: "Bearer " + token, ...headers } });
  await new Promise<void>((resolve, reject) => {
    socket.on("error", () => {});
    socket.on("open", () => { socket.terminate(); reject(new Error("Expected handshake rejection")); });
    socket.on("unexpected-response", (_req, response) => {
      response.resume();
      socket.terminate();
      if (response.statusCode === status) resolve(); else reject(new Error("Unexpected status: " + response.statusCode));
    });
  });
}
