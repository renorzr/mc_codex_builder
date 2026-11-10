import test from "node:test";
import assert from "node:assert/strict";
import { compileBuildPlan, groupBuildRows } from "../src/build-plan.js";
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
test("rejects commands, dynamic blocks, fractional or distant coordinates, and oversized regions", () => {
  for (const blockId of ["minecraft:air", "minecraft:chest", "minecraft:sand", "minecraft:stone{}", "minecraft:stone run x", "minecraft:oak_log[axis=y]"]) {
    assert.throws(() => compileBuildPlan({ ...plan, operations: [{ ...plan.operations[0], blockId }] }, player, limits));
  }
  assert.throws(() => compileBuildPlan(plan, player, { ...limits, maxBlocks: 2 }));
  assert.throws(() => compileBuildPlan(plan, { x: 100, y: 65, z: 100 }, limits));
  assert.throws(() => compileBuildPlan({ ...plan, operations: [{ ...plan.operations[0], from: { x: 1.5, y: 65, z: 1 } }] }, player, limits));
});
