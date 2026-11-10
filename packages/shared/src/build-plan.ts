import { createHash } from "node:crypto";
import { z } from "zod";

// Full static cubes only: no commands, NBT, block entities, gravity, liquids or redstone.
export const BUILD_MATERIALS = ["minecraft:stone", "minecraft:stone_bricks", "minecraft:cobblestone", "minecraft:oak_planks", "minecraft:glass", "minecraft:white_concrete", "minecraft:blue_concrete", "minecraft:bricks", "minecraft:sandstone", "minecraft:quartz_block", "minecraft:smooth_stone", "minecraft:polished_andesite"] as const;
export const blockPositionSchema = z.object({ x: z.number().int().min(-29999984).max(29999984), y: z.number().int().min(-64).max(319), z: z.number().int().min(-29999984).max(29999984) }).strict();
export const buildPlanSchema = z.object({
  name: z.string().min(1).max(80), dimension: z.literal("minecraft:overworld"),
  operations: z.array(z.object({ from: blockPositionSchema, to: blockPositionSchema, blockId: z.enum(BUILD_MATERIALS) }).strict()).min(1).max(64),
}).strict();
export const buildResponseSchema = z.object({ message: z.string().max(2000), plan: buildPlanSchema.nullable() }).strict();
export type BuildPlan = z.infer<typeof buildPlanSchema>;
export type BlockPosition = z.infer<typeof blockPositionSchema>;
export interface BuildLimits { maxBlocks: number; maxDistance: number; allowOverwrite: boolean }
export interface BuildSummary {
  name: string; dimension: string; worldId: string;
  from: BlockPosition; to: BlockPosition; materials: string[];
  changedBlocks: number; overwrittenBlocks: number; operationCount: number;
  fingerprint: string; expiresAt: string; planFile: string;
  operations: BuildPlan["operations"];
}
export const positionKey = ({ x, y, z }: BlockPosition) => `${x},${y},${z}`;
export function volume(from: BlockPosition, to: BlockPosition) { return (Math.abs(to.x - from.x) + 1) * (Math.abs(to.y - from.y) + 1) * (Math.abs(to.z - from.z) + 1); }
export function corners(from: BlockPosition, to: BlockPosition) {
  return { from: { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), z: Math.min(from.z, to.z) }, to: { x: Math.max(from.x, to.x), y: Math.max(from.y, to.y), z: Math.max(from.z, to.z) } };
}
export function positions(from: BlockPosition, to: BlockPosition): BlockPosition[] {
  const box = corners(from, to), result: BlockPosition[] = [];
  for (let y = box.from.y; y <= box.to.y; y++) for (let z = box.from.z; z <= box.to.z; z++) for (let x = box.from.x; x <= box.to.x; x++) result.push({ x, y, z });
  return result;
}

export function compileBuildPlan(raw: unknown, player: BlockPosition, limits: BuildLimits) {
  const plan = buildPlanSchema.parse(raw);
  const targets = new Map<string, BlockPosition & { blockId: string }>();
  for (const operation of plan.operations) {
    if (volume(operation.from, operation.to) > limits.maxBlocks) throw new Error("单项操作超过方块上限，请缩小建筑");
    for (const pos of positions(operation.from, operation.to)) {
      if (["x", "y", "z"].some(axis => Math.abs(pos[axis as keyof BlockPosition] - player[axis as keyof BlockPosition]) > limits.maxDistance)) throw new Error("建筑范围距离玩家过远");
      targets.set(positionKey(pos), { ...pos, blockId: operation.blockId });
      if (targets.size > limits.maxBlocks) throw new Error("计划修改范围超过方块上限");
    }
  }
  const cells = [...targets.values()].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
  const from = { x: Math.min(...cells.map(p => p.x)), y: Math.min(...cells.map(p => p.y)), z: Math.min(...cells.map(p => p.z)) };
  const to = { x: Math.max(...cells.map(p => p.x)), y: Math.max(...cells.map(p => p.y)), z: Math.max(...cells.map(p => p.z)) };
  if (volume(from, to) > limits.maxBlocks) throw new Error("建筑包围区域过大，无法完整读取验证");
  return { plan, cells, from, to };
}

// Convert the final assignment into disjoint rows. Overlapping model operations never cause hidden intermediate writes.
export function groupBuildRows(cells: Array<BlockPosition & { blockId: string }>) {
  const rows: BuildPlan["operations"] = [];
  for (const cell of [...cells].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x)) {
    const last = rows.at(-1);
    if (last && last.blockId === cell.blockId && last.to.y === cell.y && last.to.z === cell.z && last.to.x + 1 === cell.x) last.to.x = cell.x;
    else rows.push({ from: { x: cell.x, y: cell.y, z: cell.z }, to: { x: cell.x, y: cell.y, z: cell.z }, blockId: cell.blockId as typeof BUILD_MATERIALS[number] });
  }
  if (rows.length > 256) throw new Error("执行批次数超过 256，请简化建筑或拆分任务");
  return rows;
}

export function buildFingerprint(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function describeBuild(summary: BuildSummary, taskId: string) {
  return `建筑方案：${summary.name}\n世界：${summary.worldId}；维度：${summary.dimension}\n范围：(${Object.values(summary.from).join(", ")}) → (${Object.values(summary.to).join(", ")})\n实际将改变 ${summary.changedBlocks} 格，其中覆盖非空气 ${summary.overwrittenBlocks} 格；${summary.operationCount} 批。\n材料：${summary.materials.join(", ")}\n方案 ${summary.fingerprint.slice(0, 12)}；确认截止 ${summary.expiresAt}\n完整操作清单：${summary.planFile}\n输入 !codex approve ${taskId} 执行，或 !codex reject ${taskId} 取消。`;
}
