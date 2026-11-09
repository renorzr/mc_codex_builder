import path from "node:path";
import { loadConfig, loadToken } from "./config.js";
import { MockBackend } from "./backend.js";
import { CodexBackend } from "./codex/backend.js";
import { startGateway } from "./server.js";

try {
  const config = await loadConfig();
  const token = await loadToken(config.dataDir);
  const backend = config.backend === "codex" ? new CodexBackend(config) : new MockBackend();
  const gateway = await startGateway(config, token, backend);
  console.log(JSON.stringify({ ready: true, url: gateway.url, backend: backend.kind, writesEnabled: false,
    tokenSource: process.env.GATEWAY_TOKEN ? "GATEWAY_TOKEN" : path.resolve(config.dataDir, "gateway-token") }));
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void gateway.close().catch(() => { process.exitCode = 1; });
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Gateway 启动失败");
  process.exitCode = 1;
}
