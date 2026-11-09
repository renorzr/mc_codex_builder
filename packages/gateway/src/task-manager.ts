import { randomUUID } from "node:crypto";
import type { TaskSnapshot } from "@mccodex/shared";
import type { Backend } from "./backend.js";

const terminal = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
type Task = TaskSnapshot & { controller: AbortController };

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
    try {
      const result = await this.backend.run(task.worldSessionId, task.text, task.controller.signal, text => {
        if (!task.controller.signal.aborted && task.worldSessionId === this.world) this.report(this.snapshot(task), text);
      });
      if (task.controller.signal.aborted) this.update(task, "CANCELLED");
      else {
        task.result = result;
        this.report(this.snapshot(task), result);
        this.update(task, "COMPLETED");
      }
    } catch (error) {
      if (task.controller.signal.aborted) this.update(task, "CANCELLED");
      else {
        task.error = error instanceof Error ? error.message : "任务执行失败";
        this.update(task, "FAILED");
      }
    }
  }

  private update(task: Task, status: TaskSnapshot["status"]) {
    task.status = status;
    task.updatedAt = new Date().toISOString();
    this.publish(this.snapshot(task));
  }

  private snapshot({ controller: _, ...task }: Task): TaskSnapshot { return { ...task }; }

  async close() {
    this.closed = true;
    await this.setWorld(undefined);
    await this.backend.close();
  }
}
