import spawn from "cross-spawn";
import { spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

export interface RpcMessage { id?: number | string; method?: string; params?: any; result?: any; error?: { code: number; message: string } }
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class RpcClient extends EventEmitter {
  private readonly child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private buffer = "";
  private dead = false;
  private exitPromise: Promise<void>;
  private closing?: Promise<void>;

  constructor(command: string, args: string[], cwd: string, private timeoutMs: number) {
    super();
    this.child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }) as ChildProcessWithoutNullStreams;
    this.exitPromise = new Promise(resolve => this.child.once("close", () => resolve()));
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (data: string) => {
      this.buffer += data;
      if (Buffer.byteLength(this.buffer) > 16 * 1024 * 1024) return this.fail(new Error("app-server message exceeded 16 MiB"));
      let end: number;
      while ((end = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, end).trim();
        this.buffer = this.buffer.slice(end + 1);
        if (!line) continue;
        try { this.receive(JSON.parse(line)); }
        catch { this.fail(new Error("app-server returned invalid JSON-RPC")); return; }
      }
    });
    // Never forward raw stderr: it can contain user paths, configuration or credentials.
    this.child.stderr.resume();
    this.child.stdin.on("error", error => this.fail(error));
    this.child.on("error", error => this.fail(error));
    this.child.on("exit", (code, signal) => this.fail(new Error(`app-server exited (${code ?? signal})`)));
  }

  get closed() { return this.dead; }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.dead) return Promise.reject(new Error("app-server is not running"));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`app-server ${method} timed out`);
        reject(error);
        // The outcome is unknown; do not reuse this process or replay the request.
        this.fail(error);
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown) { this.send({ jsonrpc: "2.0", method, params }); }
  reply(id: number | string, result: unknown) { this.send({ jsonrpc: "2.0", id, result }); }
  reject(id: number | string, message: string) { this.send({ jsonrpc: "2.0", id, error: { code: -32601, message } }); }

  private send(message: object) {
    if (!this.dead) this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private receive(message: RpcMessage) {
    if (!message || typeof message !== "object") throw new Error("invalid RPC");
    if (message.method) {
      this.emit(message.id !== undefined ? "request" : "notification", message);
    } else if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`app-server RPC ${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result);
    }
  }

  private fail(error: Error) {
    if (this.dead) return;
    this.dead = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("closed", error);
    this.terminate();
  }

  close() {
    if (this.closing) return this.closing;
    const killTimer = setTimeout(() => this.terminate(true), 1500);
    this.closing = this.exitPromise.finally(() => { clearTimeout(killTimer); });
    this.fail(new Error("app-server closed"));
    return this.closing;
  }

  private terminate(force = false) {
    const pid = this.child.pid;
    if (process.platform === "win32" && pid !== undefined) {
      // npm exposes Codex through a .cmd shim, so the direct child is cmd.exe.
      // Kill the full tree to ensure the underlying app-server also exits.
      spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
      return;
    }
    this.child.kill(force ? "SIGKILL" : undefined);
  }
}
