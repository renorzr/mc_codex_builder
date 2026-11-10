import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import { configSchema } from "../packages/gateway/dist/config.js";
import { RpcClient } from "../packages/gateway/dist/codex/rpc.js";
import { createThreadConfig, CodexBackend } from "../packages/gateway/dist/codex/backend.js";
import { McpFabricObservation, OBSERVATION_SERVER, OBSERVATION_TOOLS } from "../packages/gateway/dist/mcp/observation.js";

const dir = await mkdtemp(path.join(os.tmpdir(), "mccodex-observe-smoke-"));
const config = configSchema.parse({ backend: "codex", dataDir: dir, world: { enabled: true, mcpServerPath: path.resolve("packages/gateway/test/fixtures/mcpfabric.mjs") } });
const log = path.join(dir, "mcp.jsonl");
// Local test environment only; never write these overrides to the user's Codex config.
process.env.MCCODEX_FIXTURE_LOG = log;
const rpc = new RpcClient("codex", config.codex.args, dir, 30000);
const modelError = process.argv.includes("--model-error");
let modelConfig = config;
if (modelError) {
  const wrapper = path.join(dir, "failing-fixture.mjs");
  await writeFile(wrapper, `process.env.MCCODEX_FIXTURE_FAIL_SCREENSHOT = "true"; await import(${JSON.stringify(pathToFileURL(config.world.mcpServerPath).href)});\n`);
  modelConfig = configSchema.parse({ ...config, world: { ...config.world, mcpServerPath: wrapper } });
}
const backend = process.argv.includes("--model") || modelError ? new CodexBackend(modelConfig) : undefined;
try {
  await rpc.request("initialize", { clientInfo: { name: "mccodex-observe-smoke", title: "MCCodex Observation Smoke", version: "0.1.0" }, capabilities: null });
  rpc.notify("initialized");
  const current = await rpc.request("config/read", { cwd: dir, includeLayers: false });
  const overrides = await createThreadConfig(config, current.config.mcp_servers);
  // env_vars is explicit because app-server only forwards configured MCP environment variables.
  overrides[`mcp_servers.${OBSERVATION_SERVER}.env_vars`] = ["MCCODEX_FIXTURE_LOG"];
  const { thread } = await rpc.request("thread/start", { cwd: dir, sandbox: "read-only", approvalPolicy: "untrusted", config: overrides, ephemeral: true });
  const adapter = new McpFabricObservation(rpc, thread.id);
  const observation = await adapter.prepare(new AbortController().signal);
  assert.equal(observation.player.x, 10);
  assert.equal(observation.player.dimension, "minecraft:overworld");
  const region = await adapter.call("get_blocks_region", { from: { x: 8, y: 64, z: 18 }, to: { x: 12, y: 66, z: 22 }, maxBlocks: 4096 });
  assert.equal(region.isError ?? false, false);
  const screenshot = await adapter.call("screenshot", {});
  assert(screenshot.content.some(item => item.type === "image" && item.mimeType === "image/png"));
  await assert.rejects(adapter.call("set_block"), /拒绝工具/);
  const before = await readFile(log, "utf8");
  for (const tool of ["set_block", "get_inventory"]) {
    let blocked = false;
    try {
      const result = await rpc.request("mcpServer/tool/call", { threadId: thread.id, server: OBSERVATION_SERVER, tool, arguments: {} });
      blocked = result.isError === true;
    } catch { blocked = true; }
    assert(blocked, "Non-allowlisted tool must be unavailable: " + tool);
  }
  // Codex itself must reject the hidden tool instead of forwarding it to the fixture.
  assert.equal(await readFile(log, "utf8"), before);
  console.log(JSON.stringify({ ok: true, data: "synthetic fixture, no Minecraft", realAppServer: true, configuredReadTools: OBSERVATION_TOOLS.length, player: observation.player, regionRead: true, screenshotReceived: true, writesBlockedBeforeMcp: true, modelInvoked: false }, null, 2));
  if (backend) {
    const progress = [];
    const run = () => backend.run("fixture-world", "这是测试世界。请读取附近一小块区域并使用 screenshot，再用简短中文报告玩家坐标、维度和读取到的方块。明确标注数据来自模拟世界，不要执行任何写入。", new AbortController().signal, text => { progress.push(text); console.log(text); });
    if (modelError) {
      await assert.rejects(run(), /读取失败/);
      console.log(JSON.stringify({ modelInvoked: true, injectedReadFailureStoppedTurn: true }));
    } else {
      const reply = await run();
      assert(progress.includes("正在读取 Minecraft：get_blocks_region"), "Model must actually read the region");
      assert(progress.includes("正在读取 Minecraft：screenshot"), "Model must actually request the screenshot");
      console.log(JSON.stringify({ modelInvoked: true, reply }, null, 2));
    }
  }
} finally {
  await rpc.close();
  if (backend) await backend.close();
  delete process.env.MCCODEX_FIXTURE_LOG;
  await rm(dir, { recursive: true, force: true });
}
