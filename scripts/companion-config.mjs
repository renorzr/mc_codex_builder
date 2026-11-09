import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { loadConfig, validToken } from "../packages/gateway/dist/config.js";

const config = await loadConfig();
if (!config.port) throw new Error("导出 Companion 配置需要固定端口");
const token = process.env.GATEWAY_TOKEN ?? (await readFile(path.join(config.dataDir, "gateway-token"), "utf8")).trim();
if (!validToken(token)) throw new Error("Gateway token 格式错误");
const file = path.resolve(process.argv[2] ?? path.join(config.dataDir, "minecraft-codex.json"));
await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
await writeFile(file, JSON.stringify({ url: `ws://127.0.0.1:${config.port}/ws`, token }, null, 2) + "\n", { mode: 0o600 });
if (process.platform !== "win32") await chmod(file, 0o600);
console.log("已写入 Companion 配置：" + file + "（含 token，请勿提交）");
