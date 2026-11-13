import { readFile } from "node:fs/promises";
import readline from "node:readline";

const snapshotFile = process.env.MCCODEX_SNAPSHOT_FILE;
type Vec3 = { x: number; y: number; z: number };
type Block = Vec3 & { id: string; state?: string };
type Region = { name: string; from: Vec3; to: Vec3; blocks: Block[] };
type Snapshot = { id: string; capturedAt: string; worldId?: string; player: unknown; terrain: unknown; regions: Region[] };
type RpcMessage = { id?: number | string; method?: string; params?: any };
const tools = [
  {
    name: "get_snapshot_summary",
    description: "Read the compact world snapshot captured at task submission time. Use this first when locating a pit, surface feature, or nearby target.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_snapshot_region",
    description: "Read exact cached blocks from the task submission snapshot. Regions may overlap, so edge queries can be partial; check coverage.complete. If data is missing, use mccodex_observe/get_block or get_blocks_region for the missing live cells. This tool itself never reads the live world and is not affected by later player movement.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" }, z: { type: "integer" } }, required: ["x", "y", "z"], additionalProperties: false },
        to: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" }, z: { type: "integer" } }, required: ["x", "y", "z"], additionalProperties: false },
        includeAir: { type: "boolean" },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_snapshot_layer",
    description: "Read one horizontal Y layer as a compact palette-encoded grid. Prefer this for locating pits, floors, air space, or surface changes. Unknown cells mean the task snapshot does not cover that coordinate.",
    inputSchema: {
      type: "object",
      properties: {
        y: { type: "integer" },
        from: { type: "object", properties: { x: { type: "integer" }, z: { type: "integer" } }, required: ["x", "z"], additionalProperties: false },
        to: { type: "object", properties: { x: { type: "integer" }, z: { type: "integer" } }, required: ["x", "z"], additionalProperties: false },
      },
      required: ["y", "from", "to"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_snapshot_block",
    description: "Read one exact cached block from the task submission snapshot. If the position is outside the snapshot, use mccodex_observe/get_block for that live position.",
    inputSchema: {
      type: "object",
      properties: { x: { type: "integer" }, y: { type: "integer" }, z: { type: "integer" } },
      required: ["x", "y", "z"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];
const air = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);
const UNKNOWN_BLOCK = "__uncovered__";
const MAX_REGION_RESULT_BLOCKS = 160;
const MAX_LAYER_CELLS = 1024;
const send = (message: Record<string, unknown>) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const reply = (id: number | string, result: unknown) => send({ id, result });
const json = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
const errorResult = (message: string, code = "SNAPSHOT_ERROR", details: Record<string, unknown> = {}) => ({
  isError: true,
  content: [{ type: "text", text: message }],
  structuredContent: { code, message, ...details },
});

async function loadSnapshot(): Promise<Snapshot> {
  if (!snapshotFile) throw new Error("MCCODEX_SNAPSHOT_FILE is not configured");
  return JSON.parse(await readFile(snapshotFile, "utf8"));
}
function contains(region: Region, p: Vec3) {
  return p.x >= region.from.x && p.x <= region.to.x && p.y >= region.from.y && p.y <= region.to.y && p.z >= region.from.z && p.z <= region.to.z;
}
function blockAt(snapshot: Snapshot, p: Vec3): Block | undefined {
  for (const region of snapshot.regions ?? []) {
    if (!contains(region, p)) continue;
    const block = (region.blocks ?? []).find(item => item.x === p.x && item.y === p.y && item.z === p.z);
    if (block) return block;
  }
  return undefined;
}
function integerPosition(value: any): value is Vec3 {
  return value && Number.isInteger(value.x) && Number.isInteger(value.y) && Number.isInteger(value.z);
}
function integerColumn(value: any): value is { x: number; z: number } {
  return value && Number.isInteger(value.x) && Number.isInteger(value.z);
}
function regionView(region: Region) {
  return { name: region.name, from: region.from, to: region.to, blockCount: region.blocks?.length ?? 0 };
}
function inside(from: Vec3, to: Vec3, p: Vec3) {
  return p.x >= from.x && p.x <= to.x && p.y >= from.y && p.y <= to.y && p.z >= from.z && p.z <= to.z;
}
async function callTool(name: string, args: any) {
  const snapshot = await loadSnapshot();
  if (name === "get_snapshot_summary") {
    return json({ id: snapshot.id, capturedAt: snapshot.capturedAt, worldId: snapshot.worldId, player: snapshot.player, terrain: snapshot.terrain, regions: (snapshot.regions ?? []).map(regionView) });
  }
  if (name === "get_snapshot_block") {
    if (!integerPosition(args)) return errorResult("x, y, z must be integers");
    const block = blockAt(snapshot, { x: args.x, y: args.y, z: args.z });
    return block ? json(block) : errorResult(
      `Position (${args.x},${args.y},${args.z}) is outside the task snapshot; use mccodex_observe/get_block to read this live position`,
      "SNAPSHOT_OUT_OF_RANGE",
      {
        regions: (snapshot.regions ?? []).map(regionView),
        fallback: { tool: "mccodex_observe/get_block", reason: "Snapshot does not cover this position" },
      },
    );
  }
  if (name === "get_snapshot_region") {
    const from = args.from, to = args.to;
    if (!integerPosition(from) || !integerPosition(to)) return errorResult("from/to must contain integer x, y, z");
    const low = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), z: Math.min(from.z, to.z) };
    const high = { x: Math.max(from.x, to.x), y: Math.max(from.y, to.y), z: Math.max(from.z, to.z) };
    const volume = (high.x - low.x + 1) * (high.y - low.y + 1) * (high.z - low.z + 1);
    if (volume > 4096) return errorResult("Snapshot region is too large; request a smaller region");
    const cached = new Map<string, Block>();
    for (const region of snapshot.regions ?? []) {
      for (const block of region.blocks ?? []) {
        if (!inside(low, high, block)) continue;
        cached.set(`${block.x},${block.y},${block.z}`, block);
      }
    }
    if (cached.size === 0) return errorResult(
      "Requested region does not overlap the task submission snapshot; use mccodex_observe/get_blocks_region for live data",
      "SNAPSHOT_OUT_OF_RANGE",
      {
        regions: (snapshot.regions ?? []).map(regionView),
        fallback: { tool: "mccodex_observe/get_blocks_region", reason: "Snapshot does not cover this region" },
      },
    );
    const includeAir = args.includeAir !== false;
    const blocks = [...cached.values()].filter(block => includeAir || !air.has(block.id));
    if (blocks.length > MAX_REGION_RESULT_BLOCKS) return errorResult(
      `Region result has ${blocks.length} blocks, above the safe compact-output limit of ${MAX_REGION_RESULT_BLOCKS}; use get_snapshot_layer for horizontal inspection or request a smaller region`,
      "SNAPSHOT_RESULT_TOO_LARGE",
      {
        limit: MAX_REGION_RESULT_BLOCKS,
        returnedBlocks: blocks.length,
        fallback: { tool: "mccodex_snapshot/get_snapshot_layer", reason: "Avoid oversized tool output that may be truncated by the app-server" },
      },
    );
    return json({
      snapshotId: snapshot.id,
      capturedAt: snapshot.capturedAt,
      from,
      to,
      includeAir,
      coverage: {
        complete: cached.size === volume,
        capturedBlocks: cached.size,
        requestedBlocks: volume,
        missingBlocks: volume - cached.size,
      },
      fallback: cached.size === volume ? null : {
        tool: "mccodex_observe/get_blocks_region",
        reason: "Snapshot coverage is partial; read only the missing live cells if needed",
      },
      blocks,
    });
  }
  if (name === "get_snapshot_layer") {
    const y = args.y, from = args.from, to = args.to;
    if (!Number.isInteger(y) || !integerColumn(from) || !integerColumn(to)) return errorResult("y must be an integer and from/to must contain integer x, z");
    const low = { x: Math.min(from.x, to.x), z: Math.min(from.z, to.z) };
    const high = { x: Math.max(from.x, to.x), z: Math.max(from.z, to.z) };
    const cells = (high.x - low.x + 1) * (high.z - low.z + 1);
    if (cells > MAX_LAYER_CELLS) return errorResult(
      `Snapshot layer is too large; request at most ${MAX_LAYER_CELLS} cells`,
      "SNAPSHOT_LAYER_TOO_LARGE",
      { limit: MAX_LAYER_CELLS, requestedCells: cells },
    );
    const layer = new Map<string, string>();
    for (const region of snapshot.regions ?? []) {
      for (const block of region.blocks ?? []) {
        if (block.y !== y || block.x < low.x || block.x > high.x || block.z < low.z || block.z > high.z) continue;
        layer.set(`${block.x},${block.z}`, block.id);
      }
    }
    const palette = [UNKNOWN_BLOCK];
    const indexes = new Map<string, number>();
    const rows = [];
    for (let z = low.z; z <= high.z; z++) {
      const values = [];
      for (let x = low.x; x <= high.x; x++) {
        const id = layer.get(`${x},${z}`);
        if (id === undefined) { values.push(0); continue; }
        let index = indexes.get(id);
        if (index === undefined) { index = palette.length; palette.push(id); indexes.set(id, index); }
        values.push(index);
      }
      rows.push({ z, cells: values });
    }
    return json({
      snapshotId: snapshot.id,
      capturedAt: snapshot.capturedAt,
      y,
      from: low,
      to: high,
      palette,
      rows,
      coverage: {
        complete: layer.size === cells,
        capturedBlocks: layer.size,
        requestedBlocks: cells,
        missingBlocks: cells - layer.size,
      },
    });
  }
  return errorResult(`Unknown snapshot tool: ${name}`, "UNKNOWN_TOOL");
}

if (!snapshotFile) {
  process.stderr.write("MCCODEX_SNAPSHOT_FILE is required\n");
  process.exit(1);
}
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message: RpcMessage = JSON.parse(line);
  if (message.id === undefined) continue;
  try {
    if (message.method === "initialize") reply(message.id, { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mccodex_snapshot", version: "0.1.0" }, instructions: "Read-only cached world snapshots captured at task submission time." });
    else if (message.method === "ping") reply(message.id, {});
    else if (message.method === "tools/list") reply(message.id, { tools });
    else if (message.method === "tools/call") reply(message.id, await callTool(message.params?.name, message.params?.arguments ?? {}));
    else send({ id: message.id, error: { code: -32601, message: "Unsupported snapshot method" } });
  } catch (error) {
    send({ id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : "Snapshot error" } });
  }
}