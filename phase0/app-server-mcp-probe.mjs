import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

const codexEntry = process.env.CODEX_JS ?? path.join(path.dirname(process.execPath), "node_modules", "@openai", "codex", "bin", "codex.js");
const serverEntry = path.resolve(".phase0/upstream/mcpfabric/mcp-server/dist/index.js");
const configArgs = [
  "-c", 'mcp_servers.mcpfabric.command="node"',
  "-c", "mcp_servers.mcpfabric.args=[" + JSON.stringify(serverEntry) + "]",
  "-c", 'mcp_servers.mcpfabric.startup_timeout_sec=30',
];
const child = spawn(process.execPath, [codexEntry, "app-server", "--stdio", ...configArgs], {
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

readline.createInterface({ input: child.stdout }).on("line", (line) => {
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
  await request("initialize", {
    clientInfo: { name: "minecraft-codex-phase0", title: "Minecraft Codex MCP Probe", version: "0.1.0" },
    capabilities: null,
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
  const started = await request("thread/start", { cwd: process.cwd(), ephemeral: true });
  const threadId = started.thread.id;
  const status = await request("mcpServerStatus/list", { threadId, serverName: "mcpfabric", detail: "full" });
  const tool = process.env.PHASE0_MCP_TOOL;
  const toolResult = tool
    ? await request("mcpServer/tool/call", {
        threadId,
        server: "mcpfabric",
        tool,
        arguments: JSON.parse(process.env.PHASE0_MCP_ARGUMENTS ?? "{}"),
      })
    : undefined;
  const serverStatus = status.data?.[0];
  console.log(JSON.stringify({
    ok: true,
    threadId,
    server: serverStatus ? {
      name: serverStatus.name,
      runtimeStatus: serverStatus.runtimeStatus,
      version: serverStatus.serverInfo?.version,
      toolCount: Object.keys(serverStatus.tools ?? {}).length,
      authStatus: serverStatus.authStatus,
    } : null,
    toolResult,
  }, null, 2));
} finally {
  child.kill();
}
