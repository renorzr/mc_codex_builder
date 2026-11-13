import test from "node:test";
import assert from "node:assert/strict";
import { buildResponseSchema, compileBuildPlan, groupBuildRows } from "../src/build-plan.js";
const player = { x: 0, y: 65, z: 0 };
const limits = { maxBlocks: 64, maxDistance: 8, allowOverwrite: false };
const plan = { name: "test", dimension: "minecraft:overworld", operations: [
  { from: { x: 1, y: 65, z: 1 }, to: { x: 3, y: 65, z: 1 }, blockId: "minecraft:stone" },
  { from: { x: 2, y: 65, z: 1 }, to: { x: 2, y: 65, z: 1 }, blockId: "minecraft:glass" },
] };
test("counts unique final target cells and groups disjoint final assignments", () => {
  const compiled = compileBuildPlan(plan, player, limits);
  assert.equal(compiled.cells.length, 3);
  assert.equal(compiled.cells[1]?.blockId, "minecraft:glass");
  const rows = groupBuildRows(compiled.cells);
  assert.equal(rows.length, 3);
  assert.equal(rows[1]?.blockId, "minecraft:glass");
});
test("accepts message-only responses and any namespaced block id", () => {
  assert.equal(buildResponseSchema.parse({ message: "没有生成计划" }).plan, undefined);
  for (const blockId of ["minecraft:sea_lantern", "minecraft:chest", "minecraft:sand", "minecraft:water", "mymod:custom_block"]) {
    const compiled = compileBuildPlan({ ...plan, operations: [{ ...plan.operations[0], blockId }] }, player, limits);
    assert.equal(compiled.cells[0]?.blockId, blockId);
  }
});

test("allows sparse plans whose bounding box exceeds maxBlocks but fits the read limit", () => {
  const sparse = {
    name: "sparse",
    dimension: "minecraft:overworld",
    operations: [
      { from: { x: 0, y: 65, z: 0 }, to: { x: 0, y: 65, z: 0 }, blockId: "minecraft:cherry_leaves" },
      { from: { x: 15, y: 65, z: 15 }, to: { x: 15, y: 65, z: 15 }, blockId: "minecraft:cherry_log" },
    ],
  };
  const compiled = compileBuildPlan(sparse, player, { maxBlocks: 2, maxDistance: 20, allowOverwrite: false });
  assert.equal(compiled.cells.length, 2);
  assert.throws(
    () => compileBuildPlan({
      ...sparse,
      operations: [
        { from: { x: 0, y: 65, z: 0 }, to: { x: 0, y: 65, z: 0 }, blockId: "minecraft:stone" },
        { from: { x: 65, y: 65, z: 65 }, to: { x: 65, y: 65, z: 65 }, blockId: "minecraft:stone" },
      ],
    }, player, { maxBlocks: 2, maxDistance: 100, allowOverwrite: false }),
    /[\u5355\u6b21\u8bfb\u53d6\u4e0a\u9650]/,
  );
});

test("structured commands are normalized, blacklisted and ordered before block operations", () => {
  const commandPlan = { ...plan, commands: ["/clone 1 65 1 3 65 1 10 65 1"] };
  const compiled = compileBuildPlan(commandPlan, player, { ...limits, allowOverwrite: true, blockedCommands: ["op", "execute"] });
  assert.deepEqual(compiled.commands, ["clone 1 65 1 3 65 1 10 65 1"]);
  assert.doesNotThrow(() => compileBuildPlan({ ...plan, commands: ["say hello"] }, player, { ...limits, allowOverwrite: true, blockedCommands: ["op", "execute"] }));
  assert.throws(() => compileBuildPlan({ ...plan, commands: ["op Codex"] }, player, { ...limits, allowOverwrite: true, blockedCommands: ["op", "execute"] }), /在 Gateway 黑名单中/);
  assert.throws(() => compileBuildPlan(commandPlan, player, { ...limits, allowOverwrite: false, blockedCommands: [] }), /allowOverwrite=true/);
  assert.throws(() => compileBuildPlan({ ...plan, commands: ["clone 1 2 3\nsetblock 0 0 0 air"] }, player, { ...limits, allowOverwrite: true, blockedCommands: [] }));
});

test("rejects commands, dynamic blocks, fractional or distant coordinates, and oversized regions", () => {
  for (const blockId of ["stone", "minecraft:stone{}", "minecraft:stone run x", "minecraft:oak_log[axis=y]", "Minecraft:Stone", "minecraft:stone\nsetblock 0 0 0 air"]) {
    assert.throws(() => compileBuildPlan({ ...plan, operations: [{ ...plan.operations[0], blockId }] }, player, limits));
  }
  assert.throws(() => compileBuildPlan(plan, player, { ...limits, maxBlocks: 2 }));
  assert.throws(() => compileBuildPlan(plan, { x: 100, y: 65, z: 100 }, limits));
  assert.throws(() => compileBuildPlan({ ...plan, operations: [{ ...plan.operations[0], from: { x: 1.5, y: 65, z: 1 } }] }, player, limits));
});
