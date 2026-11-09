import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

const codexEntry = process.env.CODEX_JS ?? path.join(path.dirname(process.execPath), "node_modules", "@openai", "codex", "bin", "codex.js");
const child = spawn(process.execPath, [codexEntry, "app-server", "--stdio"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});

const pending = new Map();
let nextId = 1;

function request(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const lines = readline.createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && pending.has(message.id)) {
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  }
});

child.stderr.on("data", (data) => process.stderr.write(data));

try {
  const initialized = await request("initialize", {
    clientInfo: { name: "minecraft-codex-phase0", title: "Minecraft Codex Phase 0", version: "0.1.0" },
    capabilities: null,
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
  const thread = await request("thread/start", { cwd: process.cwd(), ephemeral: true });
  console.log(JSON.stringify({ ok: true, initialized, threadId: thread.thread.id }, null, 2));
} finally {
  child.kill();
}
