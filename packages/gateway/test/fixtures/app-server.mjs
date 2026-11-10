import readline from "node:readline";
import { appendFileSync } from "node:fs";
const logFile = process.argv[2];
const scenario = process.argv[3] ?? "good";
const reads = ["get_status", "list_capabilities", "get_self", "get_block", "get_blocks_region", "find_blocks", "screenshot", "describe_scene"];
let thread = "fixture-thread";
let nextTurn = 0;
const turns = new Map();
const send = message => process.stdout.write(JSON.stringify(message) + "\n");
const reply = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });
const completed = (id, status = "completed") => notify("turn/completed", { threadId: thread, turn: { id, status, error: null } });
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (logFile) appendFileSync(logFile, JSON.stringify(message) + "\n");
  const { id, method, params } = message;
  if (method === "initialize") reply(id, { userAgent: "fixture", codexHome: "/fixture" });
  else if (method === "config/read") reply(id, { config: { mcp_servers: { dangerous: { enabled: true } } } });
  else if (method === "thread/start") { thread = "fixture-thread-" + Date.now(); reply(id, { thread: { id: thread } }); }
  else if (method === "thread/resume") { thread = params.threadId; reply(id, { thread: { id: thread } }); }
  else if (method === "mcpServerStatus/list") {
    const tools = Object.fromEntries(reads.filter(name => scenario !== "missing-tool" || name !== "screenshot").map(name => [name, { name, annotations: { readOnlyHint: true, destructiveHint: false } }]));
    if (scenario === "unsafe-tool") tools.set_block = { name: "set_block", annotations: { readOnlyHint: false, destructiveHint: true } };
    reply(id, { data: [{ name: "mccodex_observe", runtimeStatus: scenario === "disconnected" ? "failed" : "connected", tools, toolsError: null }], nextCursor: null });
  } else if (method === "mcpServer/tool/call") {
    if (scenario === "read-error") { reply(id, { content: [{ type: "text", text: "unreachable" }], isError: true }); continue; }
    if (scenario === "slow-preflight") continue;
    let result = params.tool === "get_status"
      ? { mod: "mcpfabric", minecraftVersion: "1.21.11", side: scenario === "dedicated" ? "dedicated_server" : "client", serverPresent: scenario !== "no-world", aiPaused: scenario === "paused", capabilities: scenario === "no-vision" ? ["world_read", "player_local"] : ["world_read", "player_local", "vision"] }
      : { x: 10, y: 65, z: 20, yaw: 90, pitch: 0, dimension: "minecraft:overworld", gameMode: "creative" };
    if (scenario === "no-player" && params.tool === "get_self") result = {};
    reply(id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
  }
  else if (method === "turn/start") {
    const text = params.input.at(-1).text;
    const turn = "turn-" + ++nextTurn;
    if (text === "crash") { process.exit(17); }
    if (text === "malformed") { process.stdout.write("{bad-json\n"); continue; }
    if (text === "hang") continue;
    const finish = () => {
      notify("item/completed", { threadId: thread, turnId: turn, item: { id: "reply-" + turn, type: "agentMessage", text: "fixture: " + text } });
      completed(turn);
    };
    turns.set(turn, finish);
    if (text === "early") { finish(); reply(id, { turn: { id: turn } }); }
    else if (text === "slow-start") { setTimeout(() => reply(id, { turn: { id: turn } }), 100); }
    else {
      reply(id, { turn: { id: turn } });
      if (text === "approval") {
        send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { threadId: thread, turnId: turn } });
        send({ id: "approval-2", method: "item/fileChange/requestApproval", params: { threadId: thread, turnId: turn } });
        send({ id: "legacy-approval", method: "execCommandApproval", params: {} });
      }
      if (text === "world-read-failed") {
        // A completed turn can already be buffered when the failed tool triggers process shutdown.
        process.stdout.write([
          { method: "item/completed", params: { threadId: thread, turnId: turn, item: { type: "mcpToolCall", server: "mccodex_observe", tool: "screenshot", status: "failed", error: { message: "fixture read error" } } } },
          { method: "turn/completed", params: { threadId: thread, turn: { id: turn, status: "completed", error: null } } },
        ].map(JSON.stringify).join("\n") + "\n");
      }
      if (text === "forbidden-tool") notify("item/started", { threadId: thread, turnId: turn, item: { type: "mcpToolCall", server: "mccodex_observe", tool: "set_block", status: "inProgress" } });
      if (text !== "slow") setTimeout(finish, 10);
    }
  } else if (method === "turn/interrupt") { reply(id, {}); completed(params.turnId, "interrupted"); }
}
