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

Gateway 懒启动一个长期 app-server 子进程；同一活跃会话复用 Thread。Codex 工作目录位于 `.local/codex-workspace`，没有把仓库源代码目录当作任务工作目录。进程异常退出时当前任务失败，下一条命令重启进程并尝试恢复 Thread；不自动重放结果未知的 Turn。若恢复请求被服务端拒绝，该任务失败并清除旧 Thread ID，再下一条新命令创建新 Thread。Codex 断线也会立即使待审批计划失效。

在初始化、配置读取、Thread 创建/恢复或世界预检期间停止任务，会关闭子进程并等待退出，不再等待正常 RPC 超时。正常模型回合仍优先使用 `turn/interrupt`。Gateway 收到退出信号后停止接受连接、关闭 WebSocket 与未完成 HTTP 连接，再取消任务并清理子进程；关闭可重复调用。

Phase 1 是聊天阶段：只读沙箱、`untrusted` 审批策略、关闭 shell/插件/apps/多 Agent/hooks/浏览器/电脑工具特性和已配置 MCP 服务，并拒绝收到的工具审批请求。Phase 3 另以可审阅、单次有效的固定建筑计划和读回验证开放有限写入，不能把审批成功视为任意世界操作权限。

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

## 任务历史与重启（Phase 4）

游戏内和终端均可使用 `!codex history [条数]`，默认 10 条，范围 1–50。历史跨世界会话和 Gateway 重启保留，只列任务编号、最近状态、时间和可选建造数量/指纹；不提供旧提示词、模型回复或工具原始结果。`status`/`queue` 仍只查询当前内存任务。历史不恢复审批、Thread、命令回执或执行队列，也不会自动重试任务。

默认日志位于 `.local/history/tasks.jsonl`，轮换归档为 `.1`、`.2`。配置字段如下，各模式均适用：

| `history` 配置 | 默认 | 范围与作用 |
|---|---|---|
| `enabled` | `true` | 设为 false 时不读写日志，历史查询明确提示未启用 |
| `maxBytes` | `1048576` | 每文件 4096–4194304 字节，追加前轮换 |
| `maxFiles` | `3` | 1–5，包含当前文件 |
| `maxEntries` | `200` | 内存最近任务索引 1–2000 条；跨重启可查询范围还受磁盘轮换限制 |

日志只保存严格校验的状态元数据，不写入提示词、模型正文、原始异常、工具内容或凭证。新目录的 POSIX 权限为 `0700`，日志为 `0600`。Windows 文件访问权限由运行目录 ACL 管理。一个 dataDir 只供一个 Gateway 写入，不提供多进程写锁。

重启时，保留记录中未结束的任务标为 `INTERRUPTED`，不会进入新任务队列。建造中断可能已经影响世界，需人工核查；不能通过历史确认旧任务或重放磁盘计划。当前日志最后一行若写到一半则截断修复，已换行的损坏记录或不完整归档会明确阻止启动，保留文件排查。运行期间写入故障不会替代原有审批或中断任务，`history.healthy` 将在本次运行中保持 false，历史查询提示记录可能不完整。

认证 `/health` 返回 `history: { enabled, healthy, recovered, retainedEntries }`；`recovered` 是本次启动标记中断的任务数。追加使用文件 flush，但轮换涉及多个文件，不是原子事务；日志有保留上限，也不记录逐批工具证据，不能作为完整审计或“绝无写入”的证明。`.local/plans/` 审核副本仍按 Phase 3 规则单独保存，不随历史日志轮换。

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

## 小型建筑与审批（Phase 3）

建造默认关闭，已有聊天与只读配置保持原有权限。复制 `config/gateway.build.example.json` 到 `.local/gateway.build.json`，编辑 `world.mcpServerPath` 后启动：

```bash
mkdir -p .local
cp config/gateway.build.example.json .local/gateway.build.json
GATEWAY_CONFIG=.local/gateway.build.json npm run dev
```

Windows 在 PowerShell 创建目录和复制配置后，设置 `$env:GATEWAY_CONFIG = '.local/gateway.build.json'`，执行 `npm run dev`。不要把示例里的占位入口路径直接用于正式运行。

游戏端除了 Phase 2 的能力，还需 `enableWorldWrite=true`。**当前上游的 `get_screen` 被 `enablePlayerControl` 门限制；为了从 MCPFabric 核对 `sp:` 世界身份，建造模式还需要手工设置 `enablePlayerControl=true`。** Gateway 没有暴露移动、交互、导航或普通命令工具，也不会自动修改这些游戏配置。`enableCommands`、`enableUiControl`、`enableSupervisedControl` 保持关闭。仅支持一个 Minecraft 实例中的主世界单人集成世界。

| `building` 配置 | 默认 | 作用 |
|---|---|---|
| `enabled` | `false` | 显式启用计划与审批后的执行 |
| `maxBlocks` | `2048` | 目标格数、单操作体积及完整包围区域体积上限；配置最大 4096 |
| `maxDistance` | `32` | 计划中每个目标坐标距离本轮玩家位置的各轴最大偏移 |
| `allowOverwrite` | `false` | 默认拒绝改变非空气方块；开启后仍需显示覆盖数量并逐任务确认 |
| `approvalTimeoutMs` | `0` | `0` 表示审批不过期；仍保持单次使用、世界/计划绑定和执行前复查 |

`config/gateway.build.example.json` 将 `codex.turnTimeoutMs` 设为 `900000`（15 分钟），避免较长规划被默认 3 分钟超时截断。

首版只支持 12 种静态整方块，材料清单在 `packages/shared/src/build-plan.ts`。不支持空气清除、方块状态、NBT、容器、液体、重力方块、红石、命令或玩家控制。计划最多 64 个填充操作；重叠部分按最终赋值去重，执行拆成互不重叠的行批次，最多 256 批。同一点使用 `set_block`，一行使用 `fill_blocks`，按高度从低到高执行。

用户仍在游戏或终端输入普通 `@codex`。明确的建造请求生成结构化计划；纯文字聊天和观察任务仍可返回文字。模型只持有读取工具，规划回合结束后 Gateway 才读取完整目标区、计算实际改变格数和非空气覆盖数，并发布审批摘要：

```text
!codex status
!codex approve [task-id]
!codex reject [task-id]
!codex stop [task-id]
```

`status` 可再次查看等待确认的摘要；`approve`/`reject` 省略 task-id 时作用于当前唯一待审批任务。完整操作清单保存在 `.local/plans/<fingerprint>.json`，供确认前查看；修改文件不会改变实际执行计划。审批只接受当前活跃任务和当前客户端会话，单次使用；即使不过期，拒绝、退出、切换世界、Gateway 重启或执行失败仍会使计划失效。配置正数 `approvalTimeoutMs` 时才启用时间过期。待审批任务占用串行队列，后续任务等待。

确认后由 Gateway 的固定执行器使用独立 Thread 调用写工具；这个 Thread 从不运行模型 Turn，模型不会拿到写工具。执行前复查 `sp:` 世界 ID、玩家维度、写入能力和整个包围区的完整状态；每批再检查上下文和将写位置，写后立即读回，出错停止后续批次，不重试。所有写参数来自内存中已校验的最终计划，不接受客户端另传坐标或方块参数。

最终检查整个包围区：目标格达到计划状态，其余格保持审批时的状态；然后获取截图，交给原只读模型会话做文字视觉检查。截图无法辨认时必须如实说明，不能用读回成功冒充视觉成功。

这些操作不是跨 RPC 的事务。检查与写入之间仍有间隙，其他程序、玩家操作或世界切换可同时发生；不支持多 Minecraft 实例，并不保证任意并发修改情况下零竞态。中断、超时或断线后可能已有部分方块生效，Gateway 不自动回滚，也不自动重放结果未知的批次。

## 无游戏建筑验证

```bash
npm run smoke:build
npm run smoke:build -- --model
```

默认使用 Gateway、WebSocket、JSON-RPC 模拟后端，检查显示审批、确认前零写入、确认后两批写入及四格读回、重复审批不重放写入。`--model` 使用真实 Codex app-server 与真实模型，连接具有临时 JSON 世界状态的独立 MCP 测试服务，额外验证结构化计划和截图检查通道，会使用账户模型额度。全部写入仅发生在临时模拟数据中，不连接 Minecraft。

建造测试图片是 128×128 的棋盘占位图，不能作为建筑外观证据。详细结果和真实游戏验收见 [Phase 3 报告](PHASE3_REPORT.md)。

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

该命令下载校验 SHA-256 的 Gson 2.13.2、JUnit Console 6.0.1，然后编译游戏无关的解析、配置、协议与 WebSocket 类，运行 6 项单元测试和 3 项实际 WebSocket 检查：认证往返、Gateway 重启重连及 12 条连续指令、注册无响应超时。**该命令不覆盖 Fabric entrypoint 和 HUD。** 完整构建中的 `FabricChatEventContractTest` 则使用真实 Fabric API。

将 Mod 放入对应客户端 `mods/`，启动 Gateway 后生成客户端配置：

```bash
npm run companion:config
# 默认输出 .local/minecraft-codex.json，包含 secret
# 或直接指定游戏配置文件：
npm run companion:config -- /path/to/.minecraft/config/minecraft-codex.json
```

Windows 示例：`npm run companion:config -- 'C:\Users\你的用户名\AppData\Roaming\.minecraft\config\minecraft-codex.json'`。目标是游戏实例的实际配置目录，启动器自定义实例可能不在此处。

进入世界时 Mod 读取配置，建立认证 WebSocket 并注册随机会话 ID。连接与注册各有 5 秒超时，最多连续尝试 5 次，退避上限 8 秒；注册成功后重置连续失败次数。失败后检查配置并重新进入世界。未连接时仍拦截 Codex 指令，在本地告知未提交，不会广播给服务器。网络回调只产生文字通知，HUD 更新由 Minecraft client thread 执行。文本帧串行发送，最多积压 16 条；超限明确提示未提交。断线、换世界或关闭后不会重发已提交或积压的指令，旧连接的回调也不会进入新会话。

## 自动化检查

```bash
npm test
npm run smoke
npm run test:java
npm run smoke:stability
```

`smoke:stability` 使用两个独立的 Gateway CLI 进程与模拟 app-server：等待建筑审批后强制终止第一个进程，再以相同 dataDir 启动，验证历史 `INTERRUPTED`、旧审批被拒绝、无任务重放且零写入；不调用模型或连接 Minecraft。Phase 4 全部证据和待验收项目见 [稳定性报告](PHASE4_REPORT.md)。

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

以上是已有 Phase 1 的验收记录。Phase 2 只读观察模式已于 2026-11-10 在同一 Windows/Fabric 环境中完成人工验收：

- [x] 欢迎消息显示“世界观察，只读”，MCP 预检通过。
- [x] 报告的坐标、朝向、维度和游戏模式与当前玩家一致，移动后新任务重新读取。
- [x] 实际区域方块和截图能传给模型，截断或无法确定的结果被明确说明。
- [x] 游戏退出、视觉能力关闭、chunk 未加载等情况明确失败；不会继续读取或宣称成功。
- [x] 建造、命令、移动请求均不会执行；`approve/reject` 不放行写入。

以上项目均在真实单人集成世界中完成验证。

Phase 3 小型建筑闭环已于 2026-11-11 在同一 Windows/Fabric 环境中完成人工验收：

- [x] 关闭建筑模式时仍保持聊天/只读行为，不会写入。
- [x] 方案生成后世界不变，确认后才按固定批次执行。
- [x] `!codex approve` 和 `!codex reject` 可省略 task-id。
- [x] 写入后逐批读回，最终区域和截图检查正常。
- [x] 拒绝、退出、切换世界和配置过期会使旧审批失效。
- [x] 默认审批不过期，建筑模型回复超时为 15 分钟。
