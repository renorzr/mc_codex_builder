import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, truncateSync, unlinkSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { TaskSnapshot } from "@mccodex/shared";
import type { GatewayConfig } from "./config.js";

const live = ["QUEUED", "RUNNING", "AWAITING_APPROVAL", "BUILDING", "VERIFYING", "CANCELLING"] as const;
const entrySchema = z.object({
  version: z.literal(1), runId: z.uuid(), taskId: z.string().min(1).max(128), worldSessionId: z.string().min(1).max(128),
  status: z.enum([...live, "COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"]),
  timestamp: z.iso.datetime(), writeStarted: z.boolean(),
  build: z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), changedBlocks: z.number().int().min(0).max(4096) }).strict().optional(),
}).strict();
export type HistoryEntry = z.infer<typeof entrySchema>;

/** Single-writer, bounded metadata journal. Never stores prompts, results, raw errors or tool payloads. */
export class TaskHistory {
  readonly file: string;
  private readonly runId = randomUUID();
  private readonly entries = new Map<string, HistoryEntry>();
  private healthy = true;
  private recovered = 0;

  constructor(dataDir: string, private readonly options: GatewayConfig["history"]) {
    this.file = path.resolve(dataDir, "history", "tasks.jsonl");
    if (!options.enabled) return;
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    for (let index = options.maxFiles - 1; index >= 0; index--) {
      const file = this.archive(index);
      if (!existsSync(file)) continue;
      const data = readFileSync(file);
      // Only an unterminated tail in the current file is recoverable. Never silently ignore committed corrupt rows.
      const end = data.length && data[data.length - 1] !== 10 ? data.lastIndexOf(10) + 1 : data.length;
      if (end !== data.length) {
        if (index !== 0) throw new Error("任务历史归档不完整，请保留文件并检查");
        truncateSync(file, end);
      }
      for (const line of data.subarray(0, end).toString("utf8").split("\n").filter(Boolean)) {
        let entry: HistoryEntry;
        try { entry = entrySchema.parse(JSON.parse(line)); }
        catch { throw new Error("任务历史文件包含损坏记录，请保留文件并检查"); }
        this.remember(entry);
      }
      if (process.platform !== "win32") chmodSync(file, 0o600);
    }
    for (const entry of [...this.entries.values()]) {
      if ((live as readonly string[]).includes(entry.status)) {
        this.append({ ...entry, runId: this.runId, timestamp: new Date().toISOString(), status: "INTERRUPTED" });
        this.recovered++;
      }
    }
  }

  status() { return { enabled: this.options.enabled, healthy: this.healthy, recovered: this.recovered, retainedEntries: this.entries.size }; }

  record(task: TaskSnapshot) {
    if (!this.options.enabled) return;
    const previous = this.entries.get(task.id);
    if (previous?.status === task.status && previous.build?.fingerprint === task.build?.fingerprint) return;
    const entry: HistoryEntry = {
      version: 1, runId: this.runId, taskId: task.id, worldSessionId: task.worldSessionId,
      status: task.status, timestamp: task.updatedAt,
      writeStarted: previous?.writeStarted === true || ["BUILDING", "VERIFYING"].includes(task.status),
      ...(task.build ? { build: { fingerprint: task.build.fingerprint, changedBlocks: task.build.changedBlocks } } : {}),
    };
    try { this.append(entry); }
    catch {
      // Logging does not undo real writes or bypass the existing in-memory authorization boundary.
      if (this.healthy) console.error("任务历史写入失败，请检查 dataDir；/health 中 history.healthy 已标记为 false。");
      this.healthy = false;
      this.remember(entry);
    }
  }

  recent(limit = 10) {
    if (!this.options.enabled) throw new Error("任务历史记录未启用");
    if (!this.healthy) throw new Error("任务历史写入故障，当前记录可能不完整，请检查运行目录");
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("历史条数必须为 1–50");
    return [...this.entries.values()].reverse().slice(0, limit).map(entry => structuredClone(entry));
  }

  describe(limit = 10) {
    const entries = this.recent(limit);
    if (!entries.length) return "暂无任务历史。历史记录只供查询，不恢复审批或自动重试。";
    return "任务历史（只读，不恢复审批或重放任务）：\n" + entries.map(entry =>
      `${entry.timestamp} ${entry.taskId} ${entry.status}` + (entry.build ? ` 建造${entry.build.changedBlocks}格 ${entry.build.fingerprint.slice(0, 12)}` : "")
      + (entry.status === "INTERRUPTED" ? "；重启前未结束，若涉及建造请核查世界" : entry.writeStarted && ["FAILED", "CANCELLED"].includes(entry.status) ? "；可能已有写入，需核查世界" : ""),
    ).join("\n");
  }

  private archive(index: number) { return index ? `${this.file}.${index}` : this.file; }
  private remember(entry: HistoryEntry) {
    this.entries.delete(entry.taskId);
    this.entries.set(entry.taskId, entry);
    if (this.entries.size > this.options.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }
  private append(entry: HistoryEntry) {
    const line = JSON.stringify(entrySchema.parse(entry)) + "\n";
    if (Buffer.byteLength(line) > this.options.maxBytes) throw new Error("Task history record is too large");
    if (existsSync(this.file) && statSync(this.file).size + Buffer.byteLength(line) > this.options.maxBytes) {
      const last = this.archive(this.options.maxFiles - 1);
      if (existsSync(last)) unlinkSync(last);
      for (let index = this.options.maxFiles - 2; index >= 0; index--) if (existsSync(this.archive(index))) renameSync(this.archive(index), this.archive(index + 1));
    }
    appendFileSync(this.file, line, { mode: 0o600, flush: true });
    this.remember(entry);
  }
}
