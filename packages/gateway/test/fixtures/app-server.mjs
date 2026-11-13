import readline from "node:readline";
import { appendFileSync, writeFileSync } from "node:fs";
const logFile = process.argv[2];
const scenario = process.argv[3] ?? "good";
if (logFile) writeFileSync(logFile + ".pid", String(process.pid));
const reads = ["get_status", "list_capabilities", "get_self", "get_block", "get_blocks_region", "find_blocks", "screenshot", "describe_scene"];
const executionTools = ["get_status", "get_self", "get_screen", "get_block", "get_blocks_region", "screenshot", "set_block", "fill_blocks", "run_command"];
const snapshotTools = ["get_snapshot_summary", "get_snapshot_region", "get_snapshot_layer", "get_snapshot_block"];
const building = scenario.startsWith("build-");
const blocks = new Map();
let screens = 0, regionReads = 0, writes = 0, commandsRun = 0, threads = 0;
const xyz = p => `${p.x},${p.y},${p.z}`;
const cells = (from, to) => {
  const result = [];
  for (let y = from.y; y <= to.y; y++) for (let z = from.z; z <= to.z; z++) for (let x = from.x; x <= to.x; x++) result.push({ x, y, z });
  return result;
};
const getBlock = pos => blocks.get(xyz(pos)) ?? (scenario === "build-occupied" ? "minecraft:cobblestone" : "minecraft:air");
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
  if ((scenario === "hang-initialize" && method === "initialize") || (scenario === "hang-config" && method === "config/read") || (scenario === "hang-thread" && method === "thread/start") || (scenario === "hang-resume" && method === "thread/resume")) continue;
  if (scenario === "reject-resume" && method === "thread/resume") { send({ id, error: { code: -32600, message: "Thread not found" } }); continue; }
  if (method === "initialize") reply(id, { userAgent: "fixture", codexHome: "/fixture" });
  else if (method === "config/read") reply(id, { config: { mcp_servers: { dangerous: { enabled: true } } } });
  else if (method === "thread/start") { thread = "fixture-thread-" + ++threads; reply(id, { thread: { id: thread } }); }
  else if (method === "thread/resume") { thread = params.threadId; threads = Math.max(threads, Number(thread.split("-").at(-1)) || 0); reply(id, { thread: { id: thread } }); }
  else if (method === "mcpServerStatus/list") {
    const names = params.serverName === "mccodex_execute" ? executionTools : params.serverName === "mccodex_snapshot" ? snapshotTools : reads;
    const tools = Object.fromEntries(names.filter(name => scenario !== "missing-tool" || name !== "screenshot").map(name => [name, { name, annotations: { readOnlyHint: !["set_block", "fill_blocks", "run_command"].includes(name), destructiveHint: ["set_block", "fill_blocks", "run_command"].includes(name) } }]));
    if (scenario === "unsafe-tool") tools.set_block = { name: "set_block", annotations: { readOnlyHint: false, destructiveHint: true } };
    reply(id, { data: [{ name: params.serverName, runtimeStatus: scenario === "disconnected" ? "failed" : "connected", tools, toolsError: null }], nextCursor: null });
  } else if (method === "mcpServer/tool/call") {
    if (scenario === "read-error") { reply(id, { content: [{ type: "text", text: "unreachable" }], isError: true }); continue; }
    if (scenario === "slow-preflight") continue;
    if (params.tool === "get_screen") {
      if (scenario === "build-no-control") { reply(id, { content: [], isError: true }); continue; }
      screens++;
      const lastWorldId = (scenario === "build-world-change" && screens >= 3) || (scenario === "build-mid-world-change" && screens >= 5) ? "sp:other" : "sp:test";
      reply(id, { content: [], structuredContent: { inWorld: true, lastWorldId } }); continue;
    }
    if (params.tool === "describe_scene") {
      const result = { untrusted: true, notice: "fixture scene", data: { eye: { x: 10, y: 66, z: 20 }, yaw: 90, pitch: 0, lookingAt: { type: "block", id: "minecraft:dirt", pos: { x: 10, y: 64, z: 20 } }, rays: [{ hit: true, id: "minecraft:dirt", distance: 2, pos: { x: 10, y: 64, z: 20 } }], entities: [] } };
      reply(id, { content: [], structuredContent: result }); continue;
    }
    if (params.tool === "get_blocks_region") {
      regionReads++;
      if (scenario === "build-stale" && regionReads >= 5) blocks.set("12,65,20", "minecraft:cobblestone");
      if (scenario === "build-readback-error" && writes > 0) blocks.set("12,65,20", "minecraft:cobblestone");
      let list = cells(params.arguments.from, params.arguments.to).map(pos => ({ ...pos, id: getBlock(pos), state: getBlock(pos) }));
      if (scenario === "build-incomplete") list.pop();
      reply(id, { content: [], structuredContent: { dimension: params.arguments.dimension, blocks: list, truncated: scenario === "build-truncated" } }); continue;
    }
    if (params.tool === "run_command") {
      commandsRun++;
      if (scenario === "build-command-error") { reply(id, { content: [], structuredContent: { success: false, output: ["fixture command failed"] } }); continue; }
      reply(id, { content: [], structuredContent: { command: params.arguments.command, success: true, resultValue: 1, output: [] } }); continue;
    }
    if (["set_block", "fill_blocks"].includes(params.tool)) {
      writes++;
      if (scenario === "build-write-error" && writes === 2) { reply(id, { content: [], structuredContent: { success: false } }); continue; }
      const args = params.arguments;
      for (const pos of cells(args.from ?? args, args.to ?? args)) blocks.set(xyz(pos), args.blockId);
      if (scenario === "build-slow-write") { setTimeout(() => reply(id, { content: [], structuredContent: { success: true } }), 500); continue; }
      reply(id, { content: [], structuredContent: { success: true } }); continue;
    }
    if (params.tool === "screenshot") {
      reply(id, { content: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=" }] }); continue;
    }
    let result = params.tool === "get_status"
      ? { mod: "mcpfabric", minecraftVersion: "1.21.11", side: scenario === "dedicated" ? "dedicated_server" : "client", serverPresent: scenario !== "no-world", aiPaused: scenario === "paused", capabilities: scenario === "no-vision" ? ["world_read", "player_local"] : ["world_read", "player_local", "vision", ...(building && scenario !== "build-no-write" ? ["world_write"] : [])] }
      : { x: 10, y: 65, z: 20, yaw: 90, pitch: 0, dimension: "minecraft:overworld", gameMode: "creative" };
    if (scenario === "no-player" && params.tool === "get_self") result = {};
    reply(id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
  }
  else if (method === "turn/start") {
    thread = params.threadId;
    const text = params.input.at(-1).text;
    const turn = "turn-" + ++nextTurn;
    if (text === "crash") { process.exit(17); }
    if (text === "malformed") { process.stdout.write("{bad-json\n"); continue; }
    if (text === "hang") continue;
    const finish = () => {
      const plan = { name: "模拟石砖柱", dimension: "minecraft:overworld", operations: [{ from: { x: 12, y: 65, z: 20 }, to: { x: 13, y: 66, z: 20 }, blockId: "minecraft:stone_bricks" }] };
      if (scenario === "build-command" || scenario === "build-command-error") plan.commands = ["clone 0 64 0 1 64 0 20 64 20"];
      const response = params.outputSchema ? JSON.stringify(scenario === "build-no-plan" ? { message: "没有生成计划：当前材料无法满足请求。" } : params.outputSchema.properties.plan ? { message: "待审批的模拟计划", plan } : { message: "模拟截图已收到，不能视作真实游戏视觉验收。" }) : "fixture: " + text;
      notify("item/completed", { threadId: thread, turnId: turn, item: { id: "reply-" + turn, type: "agentMessage", text: response, phase: "final_answer" } });
      completed(turn);
    };
    turns.set(turn, finish);
    if (text === "early") { finish(); reply(id, { turn: { id: turn } }); }
    else if (text === "slow-start") { setTimeout(() => reply(id, { turn: { id: turn } }), 100); }
    else {
      reply(id, { turn: { id: turn } });
      if (text === "trace") {
        notify("item/started", { threadId: thread, turnId: turn, item: { id: "cmd-1", type: "commandExecution", command: "echo trace-output", cwd: "C:\\work", status: "inProgress", exitCode: null, durationMs: null } });
        notify("item/completed", { threadId: thread, turnId: turn, item: { id: "cmd-1", type: "commandExecution", command: "echo trace-output", cwd: "C:\\work", status: "completed", exitCode: 0, durationMs: 12 } });
        notify("item/completed", { threadId: thread, turnId: turn, item: { id: "file-1", type: "fileChange", changes: [{ path: "C:\\work\\file.txt", kind: { type: "update", move_path: null }, diff: "" }], status: "completed" } });
        notify("item/completed", { threadId: thread, turnId: turn, item: { id: "mcp-1", type: "mcpToolCall", server: "mccodex_observe", tool: "get_self", status: "completed", error: null, durationMs: 3 } });
        notify("item/completed", { threadId: thread, turnId: turn, item: { id: "note-1", type: "agentMessage", text: "可见过程消息", phase: "commentary" } });
      }
      if (text === "approval") {
        send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { threadId: thread, turnId: turn } });
        send({ id: "approval-2", method: "item/fileChange/requestApproval", params: { threadId: thread, turnId: turn } });
        send({ id: "legacy-approval", method: "execCommandApproval", params: {} });
      }
      if (text === "snapshot-recover" || text === "snapshot-fallback") {
        notify("item/started", { threadId: thread, turnId: turn, item: { type: "mcpToolCall", server: "mccodex_snapshot", tool: "get_snapshot_region", status: "inProgress", error: null } });
        notify("item/completed", { threadId: thread, turnId: turn, item: { type: "mcpToolCall", server: "mccodex_snapshot", tool: "get_snapshot_region", status: "failed", error: { message: "outside cached range" }, durationMs: 2 } });
        if (text === "snapshot-fallback") {
          notify("item/started", { threadId: thread, turnId: turn, item: { type: "mcpToolCall", server: "mccodex_observe", tool: "get_block", status: "inProgress", error: null } });
          notify("item/completed", { threadId: thread, turnId: turn, item: { type: "mcpToolCall", server: "mccodex_observe", tool: "get_block", status: "completed", error: null, durationMs: 3 } });
        }
        notify("item/completed", { threadId: thread, turnId: turn, item: { id: "reply-" + turn, type: "agentMessage", text: text === "snapshot-fallback" ? "fixture: snapshot live fallback" : "fixture: snapshot recovered", phase: "final_answer" } });
        completed(turn);
      } else {
        if (text === "snapshot-forbidden") notify("item/started", { threadId: thread, turnId: turn, item: { type: "mcpToolCall", server: "mccodex_snapshot", tool: "set_block", status: "inProgress" } });
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
    }
  } else if (method === "turn/interrupt") { reply(id, {}); completed(params.turnId, "interrupted"); }
}
