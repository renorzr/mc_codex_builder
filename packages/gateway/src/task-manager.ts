import { randomUUID } from "node:crypto";
import { describeBuild } from "@mccodex/shared";
import type { TaskSnapshot } from "@mccodex/shared";
import type { Backend, BuildProposal } from "./backend.js";

const terminal = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
type Task = TaskSnapshot & { controller: AbortController; approval?: { accept: () => void }; executionStarted?: boolean };

export class TaskManager {
  private tasks = new Map<string, Task>();
  private world?: string;
  private active?: Task;
  private draining?: Promise<void>;
  private closed = false;

  constructor(private readonly backend: Backend, private readonly maxTasks: number,
    private readonly publish: (task: TaskSnapshot) => void,
    private readonly report: (task: TaskSnapshot, text: string) => void) {}

  async setWorld(worldSessionId?: string) {
    if (this.world === worldSessionId) return;
    const old = this.world;
    this.world = undefined;
    this.cancelAll();
    await this.draining;
    if (old) await this.backend.reset(old);
    this.tasks.clear();
    this.world = worldSessionId;
  }

  submit(worldSessionId: string, text: string): TaskSnapshot {
    if (this.closed || this.world !== worldSessionId) throw new Error("世界会话已失效，请重新连接");
    while (this.tasks.size >= this.maxTasks) {
      const completed = [...this.tasks.values()].find(task => terminal.has(task.status));
      if (!completed) throw new Error("任务队列已满");
      this.tasks.delete(completed.id);
    }
    const now = new Date().toISOString();
    const task: Task = { id: "task-" + randomUUID(), worldSessionId, text, status: "QUEUED", createdAt: now, updatedAt: now, controller: new AbortController() };
    this.tasks.set(task.id, task);
    // Start after the command ack has been sent.
    queueMicrotask(() => this.pump());
    return this.snapshot(task);
  }

  list(world: string) { return [...this.tasks.values()].filter(task => task.worldSessionId === world).map(task => this.snapshot(task)); }
  current(world: string) { return this.active?.worldSessionId === world ? this.snapshot(this.active) : undefined; }

  approve(world: string, id?: string) {
    const task = id ? this.tasks.get(id) : this.active;
    if (!task || task.worldSessionId !== world || task !== this.active || task.status !== "AWAITING_APPROVAL" || !task.approval) {
      throw new Error(id ? "当前没有该任务的待审批计划" : "当前没有等待审批的计划");
    }
    if (task.build!.expiresAt && Date.now() >= Date.parse(task.build!.expiresAt)) throw new Error("审批已过期，请重新提交任务");
    task.approval.accept();
    return this.snapshot(task);
  }

  reject(world: string, id?: string) {
    const task = id ? this.tasks.get(id) : this.active;
    if (!task || task.worldSessionId !== world || task.status !== "AWAITING_APPROVAL") {
      throw new Error(id ? "当前没有该任务的待审批计划" : "当前没有等待审批的计划");
    }
    return this.cancel(world, task.id);
  }

  cancel(world: string, id?: string) {
    const task = id ? this.tasks.get(id) : this.active ?? [...this.tasks.values()].find(t => t.status === "QUEUED");
    if (!task || task.worldSessionId !== world) throw new Error("未找到可停止的任务");
    if (terminal.has(task.status)) return this.snapshot(task);
    if (task === this.active) {
      this.update(task, "CANCELLING");
      task.controller.abort();
    } else {
      task.controller.abort();
      this.update(task, "CANCELLED");
    }
    return this.snapshot(task);
  }

  private cancelAll() {
    for (const task of this.tasks.values()) if (!terminal.has(task.status)) this.cancel(task.worldSessionId, task.id);
  }

  private pump() {
    if (this.draining || this.closed) return;
    const task = [...this.tasks.values()].find(task => task.status === "QUEUED" && task.worldSessionId === this.world);
    if (!task) return;
    this.active = task;
    this.draining = this.execute(task).finally(() => {
      this.active = undefined;
      this.draining = undefined;
      this.pump();
    });
  }

  private async execute(task: Task) {
    this.update(task, "RUNNING");
    let proposal: BuildProposal | undefined;
    try {
      const report = (text: string) => {
        if (!task.controller.signal.aborted && task.worldSessionId === this.world) this.report(this.snapshot(task), text);
      };
      let result = await this.backend.run(task.worldSessionId, task.text, task.controller.signal, report);
      if (typeof result !== "string") proposal = result;
      if (typeof result !== "string" && !task.controller.signal.aborted) {
        const plan = result;
        if (!this.backend.executeBuild) throw new Error("后端不支持执行建筑计划");
        task.build = structuredClone(plan.summary);
        await this.awaitApproval(task, plan);
        task.controller.signal.throwIfAborted();
        task.executionStarted = true;
        result = await this.backend.executeBuild(task.worldSessionId, plan, task.controller.signal, report, stage => {
          task.controller.signal.throwIfAborted();
          this.update(task, stage);
        });
      }
      if (task.controller.signal.aborted) this.update(task, "CANCELLED");
      else {
        if (typeof result !== "string") throw new Error("后端返回了无效执行结果");
        task.result = result;
        this.report(this.snapshot(task), result);
        this.update(task, "COMPLETED");
      }
    } catch (error) {
      if (task.controller.signal.aborted) {
        if (task.executionStarted) {
          task.error = error instanceof Error ? error.message : "已停止，已生效的方块不会自动回滚";
          if (task.worldSessionId === this.world) this.report(this.snapshot(task), "建造已停止。" + task.error);
        }
        this.update(task, "CANCELLED");
      }
      else {
        task.error = error instanceof Error ? error.message : "任务执行失败";
        this.update(task, "FAILED");
      }
    } finally {
      if (proposal) this.backend.discardBuild?.(proposal);
    }
  }

  private awaitApproval(task: Task, proposal: BuildProposal) {
    return new Promise<void>((resolve, reject) => {
      const abort = () => { cleanup(); reject(new Error("任务已取消")); };
      let timer: NodeJS.Timeout | undefined;
      if (proposal.summary.expiresAt) {
        timer = setTimeout(() => { cleanup(); reject(new Error("建筑审批已过期，请重新提交任务")); }, Math.max(0, Date.parse(proposal.summary.expiresAt) - Date.now()));
      }
      const cleanup = () => { if (timer) clearTimeout(timer); task.controller.signal.removeEventListener("abort", abort); task.approval = undefined; };
      task.approval = { accept: () => { cleanup(); this.update(task, "BUILDING"); resolve(); } };
      task.controller.signal.addEventListener("abort", abort, { once: true });
      this.update(task, "AWAITING_APPROVAL");
      this.report(this.snapshot(task), describeBuild(proposal.summary, task.id));
      if (task.controller.signal.aborted) abort();
    });
  }

  private update(task: Task, status: TaskSnapshot["status"]) {
    task.status = status;
    task.updatedAt = new Date().toISOString();
    this.publish(this.snapshot(task));
  }

  private snapshot({ controller: _, approval: __, executionStarted: ___, ...task }: Task): TaskSnapshot { return structuredClone(task); }

  async close() {
    this.closed = true;
    await this.setWorld(undefined);
    await this.backend.close();
  }
}
