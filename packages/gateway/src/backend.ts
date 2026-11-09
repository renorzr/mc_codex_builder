import { setTimeout as delay } from "node:timers/promises";

export interface Backend {
  readonly kind: "mock" | "codex";
  run(worldSessionId: string, text: string, signal: AbortSignal, report: (text: string) => void): Promise<string>;
  reset(worldSessionId: string): Promise<void>;
  close(): Promise<void>;
}

export class MockBackend implements Backend {
  readonly kind = "mock";
  constructor(private readonly delayMs = 80) {}
  async run(_world: string, text: string, signal: AbortSignal, report: (text: string) => void) {
    report("模拟后端正在处理；没有调用 Codex 或 Minecraft。");
    await delay(this.delayMs, undefined, { signal });
    return `模拟回复：${text}`;
  }
  async reset(_world: string) {}
  async close() {}
}
