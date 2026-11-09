import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const configSchema = z.object({
  host: z.literal("127.0.0.1").default("127.0.0.1"),
  port: z.number().int().min(0).max(65535).default(25600),
  backend: z.enum(["mock", "codex"]).default("mock"),
  dataDir: z.string().min(1).default(".local"),
  maxTasks: z.number().int().min(1).max(10000).default(100),
  heartbeatMs: z.number().int().min(100).max(60000).default(15000),
  codex: z.object({
    command: z.string().min(1).default("codex"),
    args: z.array(z.string()).default(["app-server", "--listen", "stdio://"]),
    requestTimeoutMs: z.number().int().min(100).max(120000).default(30000),
    turnTimeoutMs: z.number().int().min(100).max(1800000).default(180000),
  }).strict().default({ command: "codex", args: ["app-server", "--listen", "stdio://"], requestTimeoutMs: 30000, turnTimeoutMs: 180000 }),
}).strict();
export type GatewayConfig = z.infer<typeof configSchema>;

export async function loadConfig(env = process.env): Promise<GatewayConfig> {
  const raw = env.GATEWAY_CONFIG ? JSON.parse(await readFile(env.GATEWAY_CONFIG, "utf8")) : {};
  return configSchema.parse({ ...raw,
    ...(env.GATEWAY_BACKEND ? { backend: env.GATEWAY_BACKEND } : {}),
    ...(env.GATEWAY_PORT ? { port: Number(env.GATEWAY_PORT) } : {}),
    ...(env.GATEWAY_DATA_DIR ? { dataDir: env.GATEWAY_DATA_DIR } : {}),
  });
}

export function validToken(token: string): boolean { return /^[A-Za-z0-9_-]{32,256}$/.test(token); }

export async function loadToken(dataDir: string, envToken = process.env.GATEWAY_TOKEN): Promise<string> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  if (envToken !== undefined) {
    if (!validToken(envToken)) throw new Error("GATEWAY_TOKEN 必须是 32–256 位字母、数字、下划线或连字符");
    return envToken;
  }
  const file = path.join(dataDir, "gateway-token");
  try {
    await writeFile(file, randomBytes(32).toString("base64url") + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const token = (await readFile(file, "utf8")).trim();
  if (!validToken(token)) throw new Error("gateway-token 文件格式错误");
  if (process.platform !== "win32") await chmod(file, 0o600);
  return token;
}

export function authenticated(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const actual = Buffer.from(header);
  const expected = Buffer.from("Bearer " + token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
