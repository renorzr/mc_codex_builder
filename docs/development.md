# 本机开发

目标部署环境仍是 Windows + Minecraft Java Edition 1.21.11 + Fabric。Gateway、共享协议、Codex 适配器和 Mod 的网络部分可在 Linux 开发，不需要启动 Minecraft。

## 环境

- Node.js ≥22.16，本次使用 24.19.0。
- JDK 21，本次安装 Ubuntu `openjdk-21-jdk-headless`。
- Gradle 使用项目 Wrapper 固定的 9.8.2，不要求全局安装。
- 可选：已登录的 Codex CLI；当前 bindings 来自 0.167.0。

Ubuntu 安装 Java：

```bash
sudo apt-get update
sudo apt-get install -y openjdk-21-jdk-headless
java -version
```

克隆后在仓库根目录执行 `npm ci`。`npm run build` 按共享包、Gateway 的顺序编译 TypeScript，产物写入各包 `dist/`。

## 开发入口

```bash
npm run dev
```

默认 `mock`，监听 `127.0.0.1:25600`。首启创建 `.local/gateway-token`；token 不输出到终端，POSIX 文件权限为 `0600`。

另一终端执行 `npm run chat`，模拟游戏客户端。服务只允许一个客户端，避免多个客户端冒用同一世界会话。`/world` 会生成新会话，旧任务被取消；断开终端也会取消该连接的任务。

真实后端：

```bash
GATEWAY_BACKEND=codex npm run dev
```

PowerShell 使用 `$env:GATEWAY_BACKEND = 'codex'`，然后执行 `npm run dev`。不设置模型名，沿用用户配置。真实生成会消耗账户额度。

Gateway 懒启动一个长期 app-server 子进程；同一活跃会话复用 Thread。Codex 工作目录位于 `.local/codex-workspace`，没有把仓库源代码目录当作任务工作目录。进程异常退出时当前任务失败，下一条命令重启进程并尝试恢复 Thread；不自动重放结果未知的 Turn。

Phase 1 是聊天阶段：只读沙箱、`untrusted` 审批策略、关闭 shell/插件/apps/多 Agent/hooks/浏览器/电脑工具特性和已配置 MCP 服务，并拒绝收到的工具审批请求。建筑计划审批尚未实现，`approve/reject` 会明确报错。后续世界写入必须另行设计可执行的权限边界，不能直接移除此限制就视为具备建筑审批。

## 配置

配置按默认值 → JSON 文件 → 环境变量覆盖。JSON 字段通过严格 Schema 校验；`host` 只接受 `127.0.0.1`。

```bash
GATEWAY_CONFIG=config/gateway.example.json npm run dev
```

| 环境变量 | 作用 |
|---|---|
| `GATEWAY_CONFIG` | 配置文件路径 |
| `GATEWAY_BACKEND` | `mock` 或 `codex` |
| `GATEWAY_PORT` | 监听端口；终端客户端也需要相同值 |
| `GATEWAY_DATA_DIR` | 运行数据目录，默认 `.local` |
| `GATEWAY_TOKEN` | 可选临时 token，32–256 位 URL 安全字符，不写入文件 |

启动 Gateway 和终端时，端口、token 和数据目录应一致。自定义数据目录需自行排除 Git；默认 `.local/` 已忽略。

健康检查为 `GET /health`，必须携带 `Authorization: Bearer <token>`。只表示 Gateway 存活与后端模式；Codex 懒启动，不能由健康检查推断已完成 Codex 认证或世界连接。

## 只读世界观察（Phase 2）

`world.enabled` 默认是 false，维持已验收的 Phase 1 聊天行为。只有 `backend: "codex"` 并显式配置 MCP Server 入口文件时，才能开启观察。Gateway 不写用户的全局 Codex 配置，也不读取、复制或保存 MCPFabric Bridge token。

使用已验证的 MCPFabric 源码 commit `a49a10641af2da813bb965e09114f7052c25ab35`，其工具过滤器支持 `readonly`。只有版本号 `0.9.1` 不足以证明包含该 commit 的接口，旧的服务端包可能不支持所需过滤器。构建示例：

```bash
git clone https://github.com/denfry/mcpfabric.git .local/mcpfabric
git -C .local/mcpfabric checkout a49a10641af2da813bb965e09114f7052c25ab35
npm ci --prefix .local/mcpfabric/mcp-server --ignore-scripts
npm run build --prefix .local/mcpfabric/mcp-server
```

这些步骤只构建 Node MCP Server；游戏中还需安装相匹配的 MCPFabric 客户端 Mod。默认发现文件 `~/.mcpfabric/bridge.json` 由 MCP Server 自行读取。当前限定单一游戏实例和单人集成世界，不支持仅启动 dedicated server 或从普通多人服务器读取服务端区域。

复制观察配置到 `.local/` 后，编辑 `world.mcpServerPath`，填写构建好的 `mcp-server/dist/index.js` 的绝对路径：

```bash
mkdir -p .local
cp config/gateway.observe.example.json .local/gateway.observe.json
GATEWAY_CONFIG=.local/gateway.observe.json npm run dev
```

PowerShell：

```powershell
New-Item -ItemType Directory -Force .local | Out-Null
Copy-Item config/gateway.observe.example.json .local/gateway.observe.json
$env:GATEWAY_CONFIG = '.local/gateway.observe.json'
npm run dev
```

Windows 的 JSON 路径可以写成 `C:/path/to/mcpfabric/mcp-server/dist/index.js`。Gateway 使用当前 Node 可执行文件启动 MCP Server，不依赖 npm 的 `.cmd` shim。首次启动前如果 `.local/` 尚不存在，请先创建目录。

MCPFabric 游戏配置建议启用 `enableVision=true`，关闭 `enableWorldWrite`、`enableCommands`、`enablePlayerControl`、`enableUiControl`、`enableSupervisedControl`。不要把 Bridge token 写入 Gateway JSON。进入单人世界后，通过 Mod 或终端提交：

```text
@codex 分析我周围的场景，告诉我坐标、朝向和附近有哪些方块，并检查截图。
```

预检要求当前 MCP 连接正常、八个工具齐全且只读、客户端已连接集成服务端、AI 未暂停，并有 `world_read`、`player_local`、`vision` 能力。每次任务重新读取 `get_status` 与 `get_self`，校验坐标、朝向、维度和游戏模式，再交给模型使用。任一步失败，不启动该轮推理，不用历史数据补全。

只开放：`get_status`、`list_capabilities`、`get_self`、`get_block`、`get_blocks_region`、`find_blocks`、`screenshot`、`describe_scene`。MCP Server 通过 `world,player,vision,readonly` 过滤工具，Codex 再以 `enabled_tools` 限制这八项。其他全局 MCP、shell、插件等入口保持关闭。`mccodex_observe` 是保留的 MCP 名称，全局配置出现同名服务时会拒绝启动观察模式。

默认模型沿用用户配置，需要支持图像工具结果。区域与截图通过真实 MCP 工具交给模型；截图不经 64 KiB 的 Companion 消息通道传输。app-server 单条 JSON-RPC 上限为 16 MiB，超过时终止连接并让任务失败。此阶段通过指引要求模型从半径不超过 8 格、返回不超过 4096 块的小区域开始；实际 RPC 扫描边界仍由上游实现约束，不是独立的建造权限机制。

工具错误或超出允许工具范围时，Gateway 停止该轮观察。退出/切换世界、断开 Gateway 或 `stop` 命令沿用已有取消流程。`worldSessionId` 仍只是客户端 nonce，不是世界写权限凭据。建造、审批、移动和命令执行未开放。

## 无游戏观察验证

```bash
npm run smoke:observe
```

此命令使用真实 Codex app-server 和独立的 MCP stdio 测试服务，验证本轮玩家状态、区域 JSON、图片内容与白名单限制。测试服务使用固定上游工具 Schema、模拟坐标和 1×1 占位图片。不会连接 Minecraft，也不发起模型推理。

```bash
npm run smoke:observe -- --model
npm run smoke:observe -- --model-error
```

两项可选检查会使用账户模型额度。前者要求模型实际调用区域和截图工具；后者注入截图读取失败，检查任务是否停止。二者仍只使用模拟世界。详见 [Phase 2 报告](PHASE2_REPORT.md)。

## Java 与 Mod

完整 Mod 构建：

```bash
cd phase0/companion-mod
bash gradlew test build --no-daemon
```

Windows：`gradlew.bat test build --no-daemon`。构建输出在 `build/libs/`，不需要拥有已安装的游戏客户端。Gradle/Loom 会下载 Minecraft 编译依赖；运行游戏仍需正常的游戏环境。

无需 Gradle/Fabric 的 Java 验证：

```bash
npm run test:java
```

该命令下载校验 SHA-256 的 Gson 2.13.2、JUnit Console 6.0.1，然后编译游戏无关的解析、配置、协议与 WebSocket 类，运行单元测试，再连接真实 Node Gateway 做 Java 往返烟测。**该命令不覆盖 Fabric entrypoint 和 HUD。** 完整构建中的 `FabricChatEventContractTest` 则使用真实 Fabric API。

将 Mod 放入对应客户端 `mods/`，启动 Gateway 后生成客户端配置：

```bash
npm run companion:config
# 默认输出 .local/minecraft-codex.json，包含 secret
# 或直接指定游戏配置文件：
npm run companion:config -- /path/to/.minecraft/config/minecraft-codex.json
```

Windows 示例：`npm run companion:config -- 'C:\Users\你的用户名\AppData\Roaming\.minecraft\config\minecraft-codex.json'`。目标是游戏实例的实际配置目录，启动器自定义实例可能不在此处。

进入世界时 Mod 读取配置，建立认证 WebSocket 并注册随机会话 ID。最多连续尝试 5 次，退避上限 8 秒。失败后检查配置并重新进入世界。未连接时仍拦截 Codex 指令，在本地告知未提交，不会广播给服务器。网络回调只产生文字通知，HUD 更新由 Minecraft client thread 执行。断线不自动重发任务。

## 自动化检查

```bash
npm test
npm run smoke
npm run test:java
```

真实 Codex 可选检查：

```bash
npm run smoke -- --codex
```

此检查启用临时 Gateway、临时工作目录和两轮真实聊天，不接入 Minecraft，不修改用户全局配置。

Codex 升级后执行 `npm run codex:generate`，审查 `packages/gateway/src/codex/generated/protocol.ts` 的变化，重新运行适配器测试和真实烟测。生成器从本机 CLI 生成 bindings 并提取适配器所需类型的完整依赖，业务代码不自行猜测 DTO。

接口依据：[官方 Codex app-server 文档](https://learn.chatgpt.com/docs/app-server)，并以本机生成的 0.167.0 类型和实际运行结果为适配基线。

## 游戏内手动验收（2026-11-10 已通过）

验收环境：Windows 11，Minecraft 1.21.11，Fabric Loader 0.20.1，Fabric API 0.141.6+1.21.11，Codex CLI 0.167.0。

- [x] 普通聊天正常，`@codex`/`!codex` 不广播。
- [x] Gateway 不在时显示未连接；启动后有限重连成功。
- [x] mock 回复在本地 HUD 显示，并清楚标注模拟模式。
- [x] 真实 Codex 回复在 HUD 显示，多轮复用会话。
- [x] `status`、`queue`、`stop [task-id]` 正常。
- [x] 退出世界、切换服务器时旧任务中断，旧回复不进入新会话。
- [x] Windows 上可启动 Gateway、导出配置、构建和加载 Mod。

以上是已有 Phase 1 的验收记录。Phase 2 新的只读观察模式尚需在真实游戏中检查：

- [ ] 欢迎消息显示“世界观察，只读”，MCP 预检通过。
- [ ] 报告的坐标、朝向、维度和游戏模式与当前玩家一致，移动后新任务重新读取。
- [ ] 实际区域方块和截图能传给模型，截断或无法确定的结果被明确说明。
- [ ] 游戏退出、视觉能力关闭、chunk 未加载等情况明确失败；不会继续读取或宣称成功。
- [ ] 建造、命令、移动请求均不会执行；`approve/reject` 不放行写入。

这些项目不能由模拟测试或 Phase 1 的历史验收替代。
