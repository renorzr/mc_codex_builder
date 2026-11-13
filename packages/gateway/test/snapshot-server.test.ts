import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const server = fileURLToPath(new URL("../dist/mcp/snapshot-server.js", import.meta.url));
type Vec3 = { x: number; y: number; z: number };
type Block = Vec3 & { id: string };

function blocks(from: Vec3, to: Vec3): Block[] {
  const result: Block[] = [];
  for (let y = from.y; y <= to.y; y++) for (let z = from.z; z <= to.z; z++) for (let x = from.x; x <= to.x; x++) result.push({ x, y, z, id: "minecraft:air" });
  return result;
}

async function runCalls(snapshotFile: string, calls: unknown[]) {
  const child = spawn(process.execPath, [server], {
    env: { ...process.env, MCCODEX_SNAPSHOT_FILE: snapshotFile },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.end([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    ...calls.map((call, index) => ({ jsonrpc: "2.0", id: index + 2, method: "tools/call", params: call })),
  ].map(value => JSON.stringify(value)).join("\n") + "\n");
  const [code] = await once(child, "close");
  assert.equal(code, 0, stderr);
  return stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

test("snapshot server returns partial coverage for an overlapping edge query", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "snapshot-server-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const snapshotFile = path.join(dir, "current.json");
  await writeFile(snapshotFile, JSON.stringify({
    id: "snapshot-test",
    capturedAt: "2026-11-13T00:00:00.000Z",
    player: {},
    terrain: {},
    regions: [
      { name: "nearby", from: { x: 0, y: 0, z: 0 }, to: { x: 2, y: 2, z: 2 }, blocks: blocks({ x: 0, y: 0, z: 0 }, { x: 2, y: 2, z: 2 }) },
      { name: "side", from: { x: -2, y: 0, z: 0 }, to: { x: -1, y: 2, z: 2 }, blocks: blocks({ x: -2, y: 0, z: 0 }, { x: -1, y: 2, z: 2 }) },
      { name: "large", from: { x: 0, y: 0, z: 0 }, to: { x: 15, y: 0, z: 10 }, blocks: blocks({ x: 0, y: 0, z: 0 }, { x: 15, y: 0, z: 10 }) },
    ],
  }), "utf8");
  const responses = await runCalls(snapshotFile, [
    { name: "get_snapshot_region", arguments: { from: { x: -2, y: 0, z: 0 }, to: { x: 2, y: 3, z: 2 }, includeAir: true } },
    { name: "get_snapshot_region", arguments: { from: { x: 20, y: 20, z: 20 }, to: { x: 21, y: 21, z: 21 }, includeAir: true } },
    { name: "get_snapshot_layer", arguments: { y: 0, from: { x: -2, z: 0 }, to: { x: 2, z: 2 } } },
    { name: "get_snapshot_region", arguments: { from: { x: 0, y: 0, z: 0 }, to: { x: 15, y: 0, z: 10 }, includeAir: true } },
  ]);
  const partial = responses.find(response => response.id === 2)?.result?.structuredContent;
  assert.deepEqual(partial.coverage, { complete: false, capturedBlocks: 45, requestedBlocks: 60, missingBlocks: 15 });
  assert.equal(partial.blocks.length, 45);
  assert.equal(partial.fallback.tool, "mccodex_observe/get_blocks_region");
  const outside = responses.find(response => response.id === 3)?.result;
  assert.equal(outside.isError, true);
  assert.equal(outside.structuredContent.code, "SNAPSHOT_OUT_OF_RANGE");
  assert.equal(outside.structuredContent.fallback.tool, "mccodex_observe/get_blocks_region");
  const layer = responses.find(response => response.id === 4)?.result?.structuredContent;
  assert.equal(layer.y, 0);
  assert.equal(layer.rows.length, 3);
  assert.deepEqual(layer.rows[0].cells, [1, 1, 1, 1, 1]);
  assert.equal(layer.coverage.complete, true);
  const oversized = responses.find(response => response.id === 5)?.result;
  assert.equal(oversized.isError, true);
  assert.equal(oversized.structuredContent.code, "SNAPSHOT_RESULT_TOO_LARGE");
  assert.equal(oversized.structuredContent.fallback.tool, "mccodex_snapshot/get_snapshot_layer");
});
