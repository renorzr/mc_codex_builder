import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { compileBuildPlan, groupBuildRows, positionKey, positions, volume, buildFingerprint } from "@mccodex/shared";
import type { BuildSummary, BlockPosition } from "@mccodex/shared";
import type { BuildProposal } from "../backend.js";
import type { GatewayConfig } from "../config.js";
import type { RpcClient } from "../codex/rpc.js";
import type { ThreadStartParams, ThreadStartResponse, McpServerToolCallParams, McpServerToolCallResponse, ListMcpServerStatusResponse } from "../codex/generated/protocol.js";
import { McpFabricObservation, jsonResult, OBSERVATION_SERVER } from "./observation.js";

export const EXECUTION_SERVER = "mccodex_execute";
export const EXECUTION_TOOLS = ["get_status", "get_self", "get_screen", "get_blocks_region", "get_block", "screenshot", "set_block", "fill_blocks", "run_command"] as const;
const allowed = new Set<string>(EXECUTION_TOOLS);
const screenSchema = z.object({ inWorld: z.literal(true), lastWorldId: z.string().startsWith("sp:") });
const regionSchema = z.object({ dimension: z.string(), truncated: z.literal(false), blocks: z.array(z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int(), id: z.string(), state: z.string() })) });
type Snapshot = Map<string, { id: string; state: string }>;
type Observation = Awaited<ReturnType<McpFabricObservation["prepare"]>>;
interface Entry {
  worldSessionId: string; worldId: string; dimension: string; fingerprint: string;
  compiled: ReturnType<typeof compileBuildPlan>; rows: ReturnType<typeof groupBuildRows>;
  before: Snapshot; summary: BuildSummary;
}
interface RollbackCell extends BlockPosition { beforeId: string; beforeState: string; afterId: string }
interface RollbackRecord {
  version: 1; fingerprint: string; createdAt: string; worldId: string; dimension: string; name: string;
  from: BlockPosition; to: BlockPosition; cells: RollbackCell[]; rolledBackAt?: string;
}

export const buildingInstructions = `\n当前显式开启了小型建筑规划。你仍然只有读取工具，绝不能自行执行任何写入。
只有用户明确要求建造时才生成 plan；纯聊天或观察任务的 plan 必须为 null，并在 message 中正常回复。
规划前优先使用 Gateway 预检的 terrain.depressions；只有摘要不足时才读取小范围精确方块。截图仅在用户要求视觉判断时使用。可以使用任意合法的 namespace:block_id（原版或模组方块），按默认方块状态放置；不允许方块状态、NBT、容器数据、命令或玩家控制。液体、重力方块和容器等结果可能不稳定，必须如实说明。
plan 的 operations 是 from/to（含端点）的填充操作；用同一点表示单方块。只规划当前玩家附近、上限内的主世界建筑。
是否覆盖非空气方块由 Gateway 的 allowOverwrite 配置决定；不要自行假设禁止覆盖。若允许覆盖，审批摘要会显示覆盖数量，最终仍以用户 approve 为准。
message 简述方案，plan 只包含具体整数坐标、材料和操作。Gateway 会复核实际范围、计算真实改变数并等待用户 approve；不要声称建造已经开始或完成。
用户拒绝后不得自动换方案执行。未经用户批准不能写入任何方块。`;

export class McpFabricBuilder {
  private threadId?: string;
  private entries = new Map<string, Entry>();
  constructor(private readonly rpc: RpcClient, private readonly planningThread: string, private readonly config: GatewayConfig,
    private readonly planningConfig: NonNullable<ThreadStartParams["config"]>, private readonly workspace: string) {}

  private async ensureThread() {
    if (this.threadId) return this.threadId;
    const prefix = `mcp_servers.${EXECUTION_SERVER}`;
    const config: NonNullable<ThreadStartParams["config"]> = { ...this.planningConfig,
      [`mcp_servers.${OBSERVATION_SERVER}.enabled`]: false,
      [`${prefix}.command`]: process.execPath, [`${prefix}.args`]: [path.resolve(this.config.world.mcpServerPath!)],
      [`${prefix}.enabled`]: true, [`${prefix}.required`]: true, [`${prefix}.enabled_tools`]: [...EXECUTION_TOOLS],
      [`${prefix}.startup_timeout_sec`]: this.config.world.startupTimeoutSec, [`${prefix}.tool_timeout_sec`]: this.config.world.toolTimeoutSec,
      [`${prefix}.env`]: { MCPFABRIC_TRANSPORT: "stdio", MCPFABRIC_TOOLSETS: "world,operator,player,vision,session", MCPFABRIC_AGENT: "false", MCPFABRIC_SCRIPTS: "false", MCPFABRIC_CHANNEL: "false" },
    };
    // This thread receives diagnostics only. Never send turn/start to it.
    const result = await this.rpc.request<ThreadStartResponse>("thread/start", { cwd: this.workspace, sandbox: "read-only", approvalPolicy: "untrusted", config, ephemeral: true,
      developerInstructions: "Gateway 执行通道，不运行模型回合。只执行用户已批准的固定计划。" } satisfies ThreadStartParams);
    this.threadId = result.thread.id;
    const status = await this.rpc.request<ListMcpServerStatusResponse>("mcpServerStatus/list", { threadId: this.threadId, serverName: EXECUTION_SERVER, detail: "toolsAndAuthOnly" });
    const server = status.data.find(item => item.name === EXECUTION_SERVER);
    if (!server || server.runtimeStatus !== "connected" || EXECUTION_TOOLS.some(name => !server.tools[name]) || Object.keys(server.tools).some(name => !allowed.has(name))) {
      await this.rpc.close();
      throw new Error("MCPFabric 执行通道工具目录无效，已拒绝建造");
    }
    return this.threadId;
  }

  private async call(tool: string, args: McpServerToolCallParams["arguments"] = {}) {
    if (!allowed.has(tool)) throw new Error("执行通道拒绝计划外工具");
    return this.rpc.request<McpServerToolCallResponse>("mcpServer/tool/call", { threadId: await this.ensureThread(), server: EXECUTION_SERVER, tool, arguments: args } satisfies McpServerToolCallParams);
  }

  async identity(signal: AbortSignal) {
    signal.throwIfAborted();
    const response = await this.call("get_screen");
    if (response.isError) throw new Error("无法读取世界身份；建造模式读取 get_screen 需要 MCPFabric enablePlayerControl=true");
    const result = jsonResult(response, "get_screen");
    signal.throwIfAborted();
    const parsed = screenSchema.safeParse(result);
    if (!parsed.success) throw new Error("无法确认当前单人世界身份，不能生成或执行建筑计划");
    return parsed.data.lastWorldId;
  }

  private async readRegion(from: BlockPosition, to: BlockPosition, dimension: string, signal: AbortSignal): Promise<Snapshot> {
    signal.throwIfAborted();
    const raw = jsonResult(await this.call("get_blocks_region", { from, to, dimension, includeAir: true, includeState: true, maxBlocks: volume(from, to) }), "get_blocks_region");
    signal.throwIfAborted();
    const result = regionSchema.safeParse(raw);
    if (!result.success || result.data.dimension !== dimension) throw new Error("目标区域读取不完整或格式无效，不能写入");
    const blocks: Snapshot = new Map();
    for (const block of result.data.blocks) {
      if (block.x < from.x || block.x > to.x || block.y < from.y || block.y > to.y || block.z < from.z || block.z > to.z) throw new Error("区域返回了边界外方块");
      const key = positionKey(block);
      if (blocks.has(key)) throw new Error("区域返回了重复坐标");
      blocks.set(key, { id: block.id, state: block.state });
    }
    if (blocks.size !== volume(from, to)) throw new Error("目标区域存在未加载或缺失方块，不能写入");
    return blocks;
  }

  async propose(worldSessionId: string, raw: unknown, observation: Observation, worldId: string, signal: AbortSignal): Promise<BuildProposal> {
    const compiled = compileBuildPlan(raw, observation.player, this.config.building);
    if (compiled.plan.dimension !== observation.player.dimension || await this.identity(signal) !== worldId) throw new Error("规划期间世界或维度已改变，请重新提交任务");
    const before = await this.readRegion(compiled.from, compiled.to, compiled.plan.dimension, signal);
    const changed = compiled.cells.filter(cell => before.get(positionKey(cell))!.id !== cell.blockId);
    const overwrittenBlocks = changed.filter(cell => !["minecraft:air", "minecraft:cave_air", "minecraft:void_air"].includes(before.get(positionKey(cell))!.id)).length;
    if (overwrittenBlocks && !this.config.building.allowOverwrite) throw new Error("计划会覆盖现有非空气方块，请选择空地上方或重新规划");
    const rows = groupBuildRows(changed);
    const expiresAt = this.config.building.approvalTimeoutMs > 0 ? new Date(Date.now() + this.config.building.approvalTimeoutMs).toISOString() : undefined;
    const fingerprint = buildFingerprint({ worldSessionId, worldId, plan: compiled.plan, before: [...before], expiresAt });
    const dir = path.resolve(this.config.dataDir, "plans");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const planFile = path.join(dir, fingerprint + ".json");
    const summary: BuildSummary = { name: compiled.plan.name, dimension: compiled.plan.dimension, worldId, from: compiled.from, to: compiled.to,
      materials: [...new Set(compiled.cells.map(cell => cell.blockId))], changedBlocks: changed.length, overwrittenBlocks, commands: [...compiled.commands], operationCount: rows.length,
      fingerprint, expiresAt, planFile, operations: structuredClone(compiled.plan.operations) };
    await writeFile(planFile, JSON.stringify({ summary, note: "此文件仅供查看；执行使用 Gateway 内存中的已校验计划，不读取此文件。" }, null, 2) + "\n", { mode: 0o600 });
    signal.throwIfAborted();
    const token = randomUUID();
    this.entries.set(token, { worldSessionId, worldId, dimension: compiled.plan.dimension, fingerprint, compiled, rows, before, summary });
    return { kind: "build-plan", token, summary: structuredClone(summary) };
  }

  discard(proposal: BuildProposal) { this.entries.delete(proposal.token); }

  private rollbackDir() { return path.resolve(this.config.dataDir, "rollbacks"); }

  private async writeRollbackRecord(entry: Entry) {
    const cells = entry.compiled.cells.flatMap(cell => {
      const before = entry.before.get(positionKey(cell));
      if (!before) throw new Error("缺少目标位置的回退前状态，不能开始写入");
      if (before.id === cell.blockId) return [];
      return [{ x: cell.x, y: cell.y, z: cell.z, beforeId: before.id, beforeState: before.state, afterId: cell.blockId }];
    });
    const record: RollbackRecord = {
      version: 1, fingerprint: entry.fingerprint, createdAt: new Date().toISOString(), worldId: entry.worldId,
      dimension: entry.dimension, name: entry.summary.name, from: entry.compiled.from, to: entry.compiled.to, cells,
    };
    const dir = this.rollbackDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(dir, entry.fingerprint + ".json"), JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  }

  private async findRollbackRecord(target?: string): Promise<RollbackRecord> {
    const dir = this.rollbackDir();
    const names = (await readdir(dir).catch(() => [] as string[])).filter(name => name.endsWith(".json"));
    const candidates = target ? names.filter(name => name.slice(0, -5) === target || name.slice(0, -5).startsWith(target)) : names;
    const records: RollbackRecord[] = [];
    for (const name of candidates) {
      try {
        const record = JSON.parse(await readFile(path.join(dir, name), "utf8")) as RollbackRecord;
        if (record.version === 1 && record.fingerprint && Array.isArray(record.cells) && !record.rolledBackAt) records.push(record);
      } catch { }
    }
    records.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const record = records[0];
    if (!record) throw new Error(target ? "找不到可回退的建造记录：" + target : "没有可回退的建造记录");
    return record;
  }

  async rollback(worldSessionId: string, target: string | undefined, signal: AbortSignal, report: (text: string) => void) {
    void worldSessionId;
    const record = await this.findRollbackRecord(target);
    signal.throwIfAborted();
    const worldId = await this.identity(signal);
    if (worldId !== record.worldId) throw new Error("当前世界与回退记录不一致，已拒绝回退");
    const status = jsonResult(await this.call("get_status"), "get_status") as { capabilities?: unknown };
    if (!Array.isArray(status.capabilities) || !status.capabilities.includes("world_write")) throw new Error("MCPFabric 未开启世界写入，无法回退");
    const current = await this.readRegion(record.from, record.to, record.dimension, signal);
    const expected = new Map(record.cells.map(cell => [positionKey(cell), cell.afterId]));
    for (const [key, afterId] of expected) {
      if (current.get(key)?.id !== afterId) throw new Error("目标方块已被修改，拒绝覆盖当前世界状态");
    }
    const rows = groupBuildRows(record.cells.map(cell => ({ x: cell.x, y: cell.y, z: cell.z, blockId: cell.beforeState })));
    let restored = 0;
    report("开始回退：" + record.name);
    for (let index = 0; index < rows.length; index++) {
      signal.throwIfAborted();
      const row = rows[index]!;
      const before = await this.readRegion(row.from, row.to, record.dimension, signal);
      for (const [key, block] of before) if (expected.has(key) && block.id !== expected.get(key)) throw new Error("回退前目标方块再次变化，已停止");
      const single = volume(row.from, row.to) === 1;
      const tool = single ? "set_block" : "fill_blocks";
      const args = { from: row.from, to: row.to, blockId: row.blockId, dimension: record.dimension };
      const result = jsonResult(await this.call(tool, single ? { ...row.from, blockId: row.blockId, dimension: record.dimension } : args), tool);
      if (!result || typeof result !== "object" || !("success" in result) || result.success !== true) throw new Error("回退写入失败，已停止");
      const readback = await this.readRegion(row.from, row.to, record.dimension, signal);
      if ([...readback.values()].some(block => block.state !== row.blockId)) throw new Error("回退读回与写入前状态不一致，已停止");
      restored += readback.size;
      if (index % 8 === 0 || index === rows.length - 1) report("已回退 " + restored + "/" + record.cells.length + " 格");
    }
    const updated = { ...record, rolledBackAt: new Date().toISOString() };
    await writeFile(path.join(this.rollbackDir(), record.fingerprint + ".json"), JSON.stringify(updated, null, 2) + "\n", { mode: 0o600 });
    return "回退完成：" + record.name + "，已恢复 " + restored + " 格。";
  }

  async execute(worldSessionId: string, proposal: BuildProposal, signal: AbortSignal, report: (text: string) => void,
    stage: (value: "BUILDING" | "VERIFYING") => void) {
    const entry = this.entries.get(proposal.token);
    if (!entry || entry.worldSessionId !== worldSessionId || entry.fingerprint !== proposal.summary.fingerprint) throw new Error("建筑审批无效或已被使用");
    this.entries.delete(proposal.token); // Single use, including failures and uncertain outcomes.
    if (entry.summary.expiresAt && Date.now() >= Date.parse(entry.summary.expiresAt)) throw new Error("建筑审批已过期");
    let verified = 0;
    const stop = () => { void this.rpc.close(); };
    const executionSignal = AbortSignal.any([signal, AbortSignal.timeout(this.config.codex.turnTimeoutMs)]);
    executionSignal.addEventListener("abort", stop, { once: true });
    const checkContext = async () => {
      executionSignal.throwIfAborted();
      const current = await new McpFabricObservation(this.rpc, this.planningThread).prepare(executionSignal);
      if (current.player.dimension !== entry.dimension || !current.status.capabilities.includes("world_write") || await this.identity(executionSignal) !== entry.worldId) throw new Error("世界、维度或写入能力已改变，审批已失效");
    };
    try {
      await checkContext();
      await this.writeRollbackRecord(entry);
      const current = await this.readRegion(entry.compiled.from, entry.compiled.to, entry.dimension, executionSignal);
      for (const [key, block] of entry.before) if (current.get(key)?.state !== block.state) throw new Error("审批后目标区域发生变化，请重新规划和确认");
      stage("BUILDING");
      let expected = entry.before;
      for (let index = 0; index < entry.compiled.commands.length; index++) {
        executionSignal.throwIfAborted();
        const command = entry.compiled.commands[index]!;
        report(`执行计划命令 ${index + 1}/${entry.compiled.commands.length}：/${command}`);
        const result = jsonResult(await this.call("run_command", { command }), "run_command");
        if (!result || typeof result !== "object" || !("success" in result) || result.success !== true) {
          const output = result && typeof result === "object" && "output" in result && Array.isArray(result.output) ? `：${result.output.join(" ")}` : "";
          throw new Error(`计划命令执行失败：/${command}${output}`);
        }
      }
      if (entry.compiled.commands.length) expected = await this.readRegion(entry.compiled.from, entry.compiled.to, entry.dimension, executionSignal);
      for (let index = 0; index < entry.rows.length; index++) {
        const row = entry.rows[index]!;
        await checkContext();
        const before = await this.readRegion(row.from, row.to, entry.dimension, executionSignal);
        for (const [key, block] of before) if (expected.get(key)?.state !== block.state) throw new Error("写入前方块已改变，停止后续批次");
        executionSignal.throwIfAborted();
        const args = { from: row.from, to: row.to, blockId: row.blockId, dimension: entry.dimension };
        const single = volume(row.from, row.to) === 1;
        const tool = single ? "set_block" : "fill_blocks";
        const response = jsonResult(await this.call(tool, single ? { ...row.from, blockId: row.blockId, dimension: entry.dimension } : args), tool);
        if (!response || typeof response !== "object" || !("success" in response) || response.success !== true) throw new Error("方块写入未返回成功，停止后续批次");
        const readback = await this.readRegion(row.from, row.to, entry.dimension, executionSignal);
        if ([...readback.values()].some(block => block.id !== row.blockId)) throw new Error("写入读回不匹配，停止后续批次");
        verified += readback.size;
        if (index % 8 === 0 || index === entry.rows.length - 1) report(`已读回验证 ${verified}/${entry.summary.changedBlocks} 格。`);
      }
      return `建造完成：${entry.summary.name}；${verified} 格已读回验证。`;
    } catch (error) {
      if (executionSignal.aborted || this.rpc.closed) await this.rpc.close();
      throw new Error(`${error instanceof Error ? error.message : "建造失败"}。已验证 ${verified} 格；当前批次可能已部分生效，不自动回滚或重试。`);
    } finally { executionSignal.removeEventListener("abort", stop); }
  }
}
