import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { configSchema } from "../packages/gateway/dist/config.js";
import { MockBackend } from "../packages/gateway/dist/backend.js";
import { startGateway } from "../packages/gateway/dist/server.js";

const deps = path.resolve(".local/java-deps");
const classes = path.resolve(".local/java-check/classes");
await mkdir(deps, { recursive: true });
await rm(classes, { recursive: true, force: true });
await mkdir(classes, { recursive: true });
const artifacts = [
  ["com/google/code/gson/gson/2.13.2/gson-2.13.2.jar", "dd0ce1b55a3ed2080cb70f9c655850cda86c206862310009dcb5e5c95265a5e0"],
  ["org/junit/platform/junit-platform-console-standalone/6.0.1/junit-platform-console-standalone-6.0.1.jar", "3009120b7953bfe63add272e65b2bbeca0d41d0dfd8dea605201db15b640e0ff"],
];
const jars = [];
for (const [artifact, hash] of artifacts) {
  const file = path.join(deps, path.basename(artifact));
  let data = await readFile(file).catch(() => undefined);
  if (!data || createHash("sha256").update(data).digest("hex") !== hash) {
    const response = await fetch("https://repo.maven.apache.org/maven2/" + artifact, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error("Dependency download failed: " + artifact);
    data = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(data).digest("hex") !== hash) throw new Error("Dependency checksum mismatch: " + artifact);
    await writeFile(file, data);
  }
  jars.push(file);
}
const src = "phase0/companion-mod/src";
const pkg = "/java/dev/mccodex/companion/";
const sources = [
  ...["ChatCommand", "ChatCommandInterceptor", "GatewayConfig", "GatewayProtocol", "GatewayConnection"].map(name => `${src}/main${pkg}${name}.java`),
  ...["ChatCommandInterceptorTest", "GatewayProtocolTest", "GatewaySmokeClient"].map(name => `${src}/test${pkg}${name}.java`),
];
const classpath = [...jars, classes].join(path.delimiter);
execFileSync("javac", ["--release", "21", "-encoding", "UTF-8", "-cp", classpath, "-d", classes, ...sources], { stdio: "inherit" });
execFileSync("java", ["-jar", jars[1], "execute", "--class-path", [classes, jars[0]].join(path.delimiter), "--scan-class-path", "--disable-banner"], { stdio: "inherit" });

const token = randomBytes(32).toString("hex");
const gateway = await startGateway(configSchema.parse({ port: 0 }), token, new MockBackend());
try {
  await new Promise((resolve, reject) => {
    const child = spawn("java", ["-cp", classpath, "dev.mccodex.companion.GatewaySmokeClient", gateway.url, token], { stdio: "inherit" });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Java smoke timed out")); }, 20000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("Java smoke exited " + code)); });
  });
} finally { await gateway.close(); }
