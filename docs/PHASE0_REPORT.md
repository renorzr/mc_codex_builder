# Phase 0：依赖验证报告

验证日期：2026-11-09  
目标平台：Windows 11 Enterprise 10.0.26200 x64  
设计依据：[MVP_DESIGN.md](MVP_DESIGN.md) 的 Phase 0

## 1. 结论摘要

技术路线可行，且已完成以下真实运行链路：

1. MCPFabric 1.21.11 服务端源码实际编译成功。
2. MCPFabric 0.9.1 在 Minecraft 1.21.11 + Fabric Loader 0.19.5 上实际启动并创建临时世界。
3. MCPFabric MCP Server 通过全部 139 项上游测试。
4. Codex app-server 0.167.0 完成 JSON-RPC 初始化、创建 Thread、加载 MCPFabric MCP Server。
5. Codex app-server 通过 `mcpServer/tool/call` 实际读取世界方块、写入金块、再次读取确认，并恢复为空气。
6. 最小 Companion Mod 实际编译、测试、打包成功。
7. Fabric `ClientSendMessageEvents.ALLOW_CHAT` 的真实 API、取消语义和当前 1.21.11 artifact 已由源码与运行测试确认。
8. Java `HttpClient` WebSocket 客户端与 Node.js Gateway 完成 localhost bearer 认证和双向消息测试。

未完成的唯一 GUI 检查：`runClient` 停在 Loom `downloadAssets`，连续 7 分钟没有进度，因此没有在真实聊天框中手工键入 `@codex`。这不影响接口和编译结论，但进入 Phase 1 前应补一次人工烟测。

## 2. 已验证的技术依赖及版本

| 组件 | 已验证版本 | 验证依据 |
|---|---:|---|
| MCPFabric 仓库 | `denfry/mcpfabric` commit `a49a10641af2da813bb965e09114f7052c25ab35` | 本地浅克隆源码、源码审查、编译、运行 |
| MCPFabric Mod | `0.9.1+1.21.11` | `gradle.properties`、运行时 `get_status` |
| Minecraft | `1.21.11` | `versions/1.21.11/gradle.properties`、服务端启动日志 |
| Fabric Loader | `0.19.5` | MCPFabric 配置、服务端启动日志 |
| Fabric API | `0.141.6+1.21.11` | MCPFabric 版本节点、Maven POM、服务端启动日志 |
| Fabric Message API | `6.1.12+4ebb5c083e` | Fabric API POM、对应 sources JAR |
| Fabric Loom | `1.17.11` | MCPFabric 与 Companion 构建日志 |
| Stonecutter | `0.9.8` | MCPFabric `settings.gradle`、构建日志 |
| Java | Temurin `21.0.13+9 LTS` | `java -version`、Gradle 构建、Minecraft 运行 |
| Gradle | `9.8.2` | 上游 Wrapper；SHA-256 与 Wrapper 指定值一致 |
| MCPFabric MCP Server | `0.9.1` | `mcp-server/package.json`、Codex MCP 状态 |
| MCP SDK | `@modelcontextprotocol/sdk 1.32.2` | `mcp-server/package.json` |
| Node.js | `24.8.0` | 本机运行；满足 MCPFabric `>=22.16` |
| npm | `11.6.0` | 本机运行 |
| Gateway WebSocket 库 | `ws 8.18.3` | 本地探针安装与运行 |
| Codex CLI | `0.167.0` | `codex --version`、`codex doctor --json` |
| Codex app-server | `0.167.0` | `--print-startup-config`、真实握手 |

重要兼容性结论：Java 17 不能构建当前上游。Loom 1.17.11 要求 Java 21，Stonecutter 0.9.8 要求 Gradle 9；所以项目基线必须是 Java 21 + Gradle 9，而不是只在 `java.toolchain` 中声明 21。

## 3. MCPFabric 实际架构和接口

MCPFabric 由两部分组成：

1. Minecraft Mod 内嵌的 HTTP Bridge。
2. 独立 Node.js MCP Server，把 Bridge RPC 映射为 MCP 工具。

### 3.1 Bridge HTTP 接口

源码：`.phase0/upstream/mcpfabric/src/main/java/dev/mcpfabric/bridge/HttpBridgeServer.java`

| 方法 | 路径 | 认证 | 实际作用 |
|---|---|---|---|
| `GET` | `/health` | 无 | 返回 `{ok:true,name:"mcpfabric"}` |
| `GET` | `/info` | Bearer | 调用 `info.status` 并直接返回 result |
| `POST` | `/rpc` | Bearer | `{method,params}` RPC 调度 |
| `GET` | `/events` | Bearer | SSE 事件流，15 秒注释心跳 |

RPC 请求不是完整 JSON-RPC 2.0 envelope，而是：

```json
{
  "method": "world.getBlock",
  "params": { "x": 0, "y": 64, "z": 0 }
}
```

响应：

```json
{ "ok": true, "result": {} }
```

或：

```json
{
  "ok": false,
  "error": { "code": "...", "message": "...", "data": null }
}
```

`POST /rpc` 强制 `Content-Type: application/json`，请求体上限 1 MiB。带 `Origin` 的浏览器请求会被拒绝。

### 3.2 Bridge 认证

源码：`.phase0/upstream/mcpfabric/src/main/java/dev/mcpfabric/config/McpConfig.java` 与 `HttpBridgeServer.java`

- 默认监听 `127.0.0.1:25599`。
- 默认 `requireAuth=true`。
- `token` 是完整访问 token。
- `readToken` 只允许 `ReadAccess` 白名单方法；写调用返回 403。
- Authorization 格式是 `Authorization: Bearer <token>`。
- token 比较使用常量时间字节比较。
- `enableWorldWrite`、`enableCommands`、`enablePlayerControl`、`enableVision`、`enableUiControl`、`enableSupervisedControl` 是独立能力门。
- `requireApproval` 可对 `command`、`world_write`、`players_admin` 做游戏内逐请求审批。

### 3.3 Bridge 发现文件

源码：`.phase0/upstream/mcpfabric/src/main/java/dev/mcpfabric/bridge/DiscoveryFile.java`

默认文件：`~/.mcpfabric/bridge.json`。

实际字段：

```json
{
  "url": "http://127.0.0.1:25599",
  "token": "<secret>",
  "pid": 12345,
  "side": "client|dedicated_server",
  "loader": "fabric|neoforge",
  "minecraftVersion": "1.21.11"
}
```

- 使用临时文件后原子替换。
- 游戏退出时，仅当 PID 仍属于当前进程才删除。
- MCP Server 每次调用可重新读取该文件，因此游戏重启后无需重启 MCP Server。
- POSIX 上设置 `rw-------`；Windows 上没有显式 ACL 修改，源码假设用户 Profile 目录已私有。
- 本次测试在服务端正常退出后确认发现文件已删除。

### 3.4 MCP Server 传输

源码：`.phase0/upstream/mcpfabric/mcp-server/src/index.ts` 与 `config.ts`

- 默认：MCP stdio。
- 可选：Streamable HTTP，监听 `127.0.0.1:<MCPFABRIC_HTTP_PORT>/mcp`，默认端口 25600。
- HTTP MCP 入口检查 Host、端口和 Origin，防止非本地访问与 DNS rebinding；没有额外 bearer token。
- Bridge token 与 MCP transport 认证是两层不同概念。

因此本项目应使用 MCP stdio，不建议开启 MCPFabric 的 HTTP MCP transport。

### 3.5 MCP 工具目录

当前 Codex app-server 实际获取到 105 个工具：

- 71 个 Bridge 工具。
- 26 个 Agent runtime 工具。
- 5 个 QuickJS Script/Skill 工具。
- 3 个 MCP App dashboard 工具。

完整工具名、Bridge method 和 MCP annotations 已生成到：`phase0/evidence/mcpfabric-tools.json`。

MVP 直接需要的真实工具映射：

| 需求 | MCP 工具 | Bridge method | 限制 |
|---|---|---|---|
| 状态 | `get_status` | `info.status` | 两端可用 |
| 能力列表 | `list_capabilities` | `info.capabilities` | 两端可用 |
| 本地玩家状态 | `get_self` | `player.getState` | 客户端专用 |
| 单方块读取 | `get_block` | `world.getBlock` | chunk 必须已加载 |
| 区域读取 | `get_blocks_region` | `world.getBlocks` | 最大扫描体积 16,777,216；结果默认上限 32,768 |
| 附近查找 | `find_blocks` | `world.findBlocks` | 只搜索已加载 chunk |
| 截图 | `screenshot` | `vision.screenshot` | 客户端专用 |
| 场景描述 | `describe_scene` | `vision.describeScene` | 客户端专用 |
| 写单方块 | `set_block` | `world.setBlock` | 需要服务端或集成服务端 |
| 区域填充 | `fill_blocks` | `world.fill` | 受原版 `/fill` 限制 |
| 本地 HUD 消息 | `show_message` | `chat.showLocal` | 客户端专用，不发给服务器 |
| 发送聊天 | `send_chat` | `chat.send` | 会发送给服务器/其他玩家，不适合系统回复 |
| 最近聊天 | `get_recent_chat` | `chat.getRecent` | 返回内容标记为 untrusted |
| 事件轮询 | `poll_events` | `events.getRecent` | 读取事件 ring buffer |

结论：MCPFabric 已提供主动本地聊天显示接口 `show_message`。设计文档中“是否提供主动发送游戏聊天消息接口”的答案是“提供”，并且应优先使用 `show_message` 而不是 `send_chat`。

## 4. Fabric 1.21.11 聊天拦截接口

精确 artifact：`fabric-message-api-v1:6.1.12+4ebb5c083e`。

源码：`.phase0/fabric-message-api-v1-6.1.12/net/fabricmc/fabric/api/client/message/v1/ClientSendMessageEvents.java`

真实接口：

```java
ClientSendMessageEvents.ALLOW_CHAT.register(message -> {
    if (isCodexMessage(message)) {
        return false;
    }
    return true;
});
```

确认的语义：

- `ALLOW_CHAT` 在客户端即将发送普通聊天消息时触发。
- listener 返回 `false` 后，消息不会发送。
- 后续 listener 不再执行。
- `CHAT_CANCELED` 被触发，而不是 `MODIFY_CHAT`。
- 命令是独立的 `ALLOW_COMMAND` 事件，消息文本不带 `/`。

本项目实现位置：

- `phase0/companion-mod/src/main/java/dev/mccodex/companion/CodexCompanionClient.java`
- `phase0/companion-mod/src/main/java/dev/mccodex/companion/ChatCommandInterceptor.java`

运行验证：

- `ChatCommandInterceptorTest` 验证 `@codex`、`!codex`、普通聊天。
- `FabricChatEventContractTest` 直接向真实 `ClientSendMessageEvents.ALLOW_CHAT` 注册 listener，并调用 invoker；`@codex` 返回 false，普通聊天返回 true。
- Companion Mod `test + build` 成功，生成可加载 JAR。

## 5. Companion Mod 最小开发环境

目录：`phase0/companion-mod`

构建产物：

- `phase0/companion-mod/build/libs/minecraft-codex-companion-0.0.1-phase0.jar`
- `phase0/companion-mod/build/libs/minecraft-codex-companion-0.0.1-phase0-sources.jar`

当前范围仅包括：

- Fabric 客户端 entrypoint。
- `@codex` 和 `!codex` 前缀识别。
- 命中时返回 false 取消发送。
- 在 Minecraft client thread 安排本地 HUD 回显。
- 纯解析测试和 Fabric 事件契约测试。

未实现 Gateway 任务提交、任务状态、审批和 Codex 调用；这些属于 Phase 1。

## 6. Companion Mod 与 Node.js Gateway 通信

探针目录：`phase0/gateway-probe`

实际运行：

- Node.js `ws` 服务监听 `127.0.0.1:25600/ws`。
- Upgrade 请求使用 `Authorization: Bearer <token>`。
- Java 使用 JDK 内置 `java.net.http.HttpClient` / `WebSocket`，无需给 Mod 增加第三方 WebSocket 客户端依赖。
- Gateway 发送 `gateway.hello`。
- Java 发送 `companion.probe`。
- Gateway 返回 `gateway.echo`。
- 运行结果：`JAVA_WEBSOCKET_PROBE_OK`。

建议协议：单条 WebSocket 双向通道，HTTP 仅保留 `/health` 和可选诊断，不再用 `POST /api/chat/command` 作为主通道。

推荐消息 envelope：

```json
{
  "protocolVersion": 1,
  "type": "chat.command",
  "messageId": "uuid",
  "timestamp": "2026-11-09T00:00:00Z",
  "payload": {
    "text": "在我面前建一座塔"
  }
}
```

响应/推送继续使用同一 envelope，`type` 可取：

- `gateway.hello`
- `client.ready`
- `chat.command`
- `command.accepted`
- `task.status`
- `task.approval_required`
- `task.completed`
- `task.failed`
- `task.cancel`
- `ping`
- `pong`

## 7. Codex CLI 和 app-server 实际能力

本机 `codex-cli 0.167.0`，`codex doctor` 显示持久 app-server daemon 正在运行。

### 7.1 app-server 启动接口

`codex app-server --help` 的当前能力：

- 默认 `--listen stdio://`。
- 支持 `stdio://`。
- 支持 `unix://` / `unix://PATH`。
- 支持 `ws://IP:PORT`。
- 支持 `off`。
- WebSocket 认证支持 `capability-token` 或 `signed-bearer-token`。
- 支持生成 TypeScript bindings 和 JSON Schema。

本次生成的协议文件：`.phase0/codex-app-server/schema` 和 `.phase0/codex-app-server/typescript`。

### 7.2 实际 JSON-RPC 方法

已通过真实 stdio 握手验证：

1. `initialize`
2. 客户端 notification `initialized`
3. `thread/start`

当前 v2 bindings 中与 MVP 直接相关的方法：

- `thread/start`
- `thread/resume`
- `turn/start`
- `turn/interrupt`
- `mcpServerStatus/list`
- `mcpServer/tool/call`
- `config/mcpServer/reload`

典型通知包括：

- `thread/started`
- `turn/started`
- `item/started`
- `item/completed`
- `item/agentMessage/delta`
- `item/mcpToolCall/progress`
- `turn/completed`
- `mcpServer/startupStatus/updated`

不要手写固定 DTO；Phase 1 应把当前安装版本生成的 TypeScript bindings 纳入 adapter，并在 Codex 升级时重新生成和做兼容检查。

### 7.3 app-server 加载 MCPFabric

探针：`phase0/app-server-mcp-probe.mjs`

实际结果：

- MCP server name：`mcpfabric`。
- runtime status：`connected`。
- server version：`0.9.1`。
- advertised tools：105。
- stdio MCP auth status：`unsupported`，即没有 OAuth；安全边界来自本地子进程和 Bridge bearer token。

## 8. Codex app-server → MCPFabric → 世界读写验证

运行环境：Minecraft 1.21.11 Fabric dedicated dev server，临时生成世界，没有玩家连接。

验证步骤：

1. app-server 调用 `get_status`，返回 `mcpfabric 0.9.1+1.21.11`、`loader=fabric`、`side=dedicated_server`、`serverPresent=true`。
2. 通过 `run_command` 执行 `forceload add 0 0`，确保测试 chunk 已加载。
3. `get_block(0,200,0)` 返回 `minecraft:air`。
4. `set_block(0,200,0,minecraft:gold_block)` 返回 `success=true`、`state=minecraft:gold_block`。
5. 再次 `get_block` 返回 `minecraft:gold_block`，`hardness=3`。
6. `set_block(...,minecraft:air)` 恢复原状态。
7. `forceload remove 0 0` 清理强制加载。
8. 向服务端输入 `stop`，世界保存成功，Bridge 端口和发现文件均清理。

结论：Codex app-server 可以通过 MCPFabric MCP Server 读取并修改 Minecraft 1.21.11 世界。该结论来自真实世界写入和读回，不是 mock。

## 9. 建议采用的通信协议

### 9.1 Companion ↔ Gateway

采用 `ws://127.0.0.1:25600/ws`：

- WebSocket Upgrade bearer token。
- JSON envelope + `protocolVersion`。
- 每条命令带 `messageId`，Gateway 返回幂等 ack。
- Gateway 为唯一 WebSocket server，Companion 为 client。
- Companion 网络回调只入队；所有 Minecraft 对象访问经 `Minecraft.getInstance().execute(...)`。
- 限制消息大小、心跳周期、重连次数和退避上限。

### 9.2 Gateway ↔ Codex app-server

采用 app-server 默认 stdio JSON-RPC：

- Gateway 启动并长期持有一个 `codex app-server --stdio` 进程。
- 启动时 `initialize` + `initialized`。
- 为一个 Minecraft 活跃世界维护一个长期 Thread。
- 用户任务使用 `turn/start`。
- 停止任务使用 `turn/interrupt`。
- 订阅 server notifications 生成聊天进度。
- 不需要为 app-server 再开放 WebSocket 端口。

### 9.3 Codex app-server ↔ MCPFabric MCP Server

采用 MCP stdio 子进程：

- Codex 配置启动 `node <mcpfabric>/dist/index.js`。
- 不配置 `MCPFABRIC_TOKEN` 时，MCP Server 从 `~/.mcpfabric/bridge.json` 自动发现当前游戏。
- 设置 `MCPFABRIC_TOOLSETS=world,player,vision,chat,events`，排除 operator、ui、supervised、agent、script 等 MVP 不需要的工具。
- `info` 工具会自动保留。

### 9.4 MCPFabric MCP Server ↔ Minecraft Bridge

沿用上游：

- `POST /rpc` 做请求/响应。
- `GET /events` 做 SSE 事件。
- bearer token 来自发现文件。
- Gateway 不读取、不复制、不持久化 Bridge token。

## 10. 已发现的兼容性和安全问题

1. **Java 17 不兼容。** Loom 1.17.11 要求 Java 21；Stonecutter 0.9.8 还要求 Gradle 9。
2. **客户端和服务端工具集合不同。** `get_self`、`screenshot`、`describe_scene`、`show_message` 等客户端专用工具无法在 dedicated server 测试。
3. **Toolset 粒度不等同权限。** `player` group 同时包含读取和控制工具；应配合 `enablePlayerControl=false`，不能只依赖工具隐藏。
4. **MCP HTTP transport 无 bearer auth。** 虽然只允许本地 Host/Origin，仍建议不用，采用 stdio。
5. **Windows discovery ACL 不是显式设置。** 上游只依赖用户 Profile 权限；部署时应检查实际 ACL。
6. **`build` profile 不包含 `get_self`。** 不能直接只选 `build`；至少要补 `player`，再关闭 player control gate。
7. **`send_chat` 会广播。** 游戏内 AI 回复必须使用 `show_message` 或 Companion HUD，不得用 `send_chat`。
8. **写工具需要已加载 chunk。** 对远处区域操作前要验证加载状态，不能假设任意坐标可写。
9. **MCP 工具目录会变化。** 当前 main commit 比 0.9.1 发布节点含未发布改动，不能把 105 或参数结构硬编码为永久常量。
10. **app-server 仍标记 experimental。** 协议应通过生成的 Schema/bindings 适配，不能按 CLI 文本输出猜测。
11. **本机 Codex 配置有废弃项。** `disable_response_storage` 被 0.167.0 忽略；这不阻塞 Phase 0，但应从用户配置清理。
12. **GUI 客户端资源下载受阻。** `runClient` 卡在 `downloadAssets`；需要在网络可达时补手工聊天框烟测。

## 11. 需要调整的架构设计

1. **Companion ↔ Gateway 主通道改为单 WebSocket。** 原设计的 HTTP 提交 + WebSocket 推送可简化为一条双向连接，减少两个认证和重试状态机。
2. **新增 `CodexAppServerAdapter`。** 封装当前 JSON-RPC bindings、通知归一化、Thread 恢复和版本检查。
3. **新增 `McpFabricAdapter`。** 保存所需工具语义，不在业务代码散落工具名；启动后用 `mcpServerStatus/list` 校验工具存在。
4. **正常任务不直接调用 Bridge。** Gateway 只管理 app-server；MCPFabric MCP Server 自己发现和认证 Bridge。
5. **允许 Gateway 做少量 app-server 直连诊断。** `mcpServerStatus/list` 和 `mcpServer/tool/call(get_status)` 可用于启动健康检查，但建造任务仍走 Codex Turn。
6. **默认收紧 MCPFabric 配置。** MVP 建议 `enableWorldWrite=true`、`enableVision=true`、`enableCommands=false`、`enablePlayerControl=false`、`enableUiControl=false`、`enableSupervisedControl=false`；需要带 NBT 数据或命令时再单独评审。
7. **利用上游 `show_message`。** Codex 工具调用期间可直接显示本地消息；Gateway 自身状态仍由 Companion HUD 显示，避免把普通状态也变成 Codex Turn。
8. **世界身份以 MCPFabric 为准。** 不信任聊天请求携带的坐标和世界信息；任务执行前重新读取 `get_status`、`get_self` 和世界状态。
9. **保留上游审计。** 开启 `auditLog=true`，Gateway 另记录 taskId、turnId、审批和工具结果摘要。
10. **审批边界分层。** Gateway 做“整项建筑计划”审批；MCPFabric `requireApproval` 只作为高危命令的额外防线，不应对每个方块重复弹窗。

## 12. Phase 0 可执行测试计划

### P0-01 版本与源码固定

```powershell
git -C .phase0/upstream/mcpfabric rev-parse HEAD
Get-Content .phase0/upstream/mcpfabric/versions/1.21.11/gradle.properties
```

通过条件：commit 和 Minecraft/Fabric/Java 版本被记录。

### P0-02 MCPFabric 1.21.11 编译

```powershell
$env:JAVA_HOME = '<JDK21>'
.\.phase0\upstream\mcpfabric\gradlew.bat :1.21.11:compileJava :1.21.11:compileClientJava --no-daemon
```

通过条件：两个 compile task 成功。本次已通过。

### P0-03 MCPFabric MCP Server 测试

```powershell
Push-Location .phase0\upstream\mcpfabric\mcp-server
npm install --ignore-scripts
npm run typecheck
npm test
Pop-Location
```

通过条件：139 tests，0 fail。本次已通过。

### P0-04 Companion 构建与聊天契约

```powershell
Push-Location phase0\companion-mod
.\gradlew.bat test build --no-daemon
Pop-Location
```

通过条件：测试与 remap JAR 成功。本次已通过。

### P0-05 Companion GUI 手工烟测

```powershell
Push-Location phase0\companion-mod
.\gradlew.bat runClient --no-daemon
Pop-Location
```

手工检查：

1. 创建临时单人世界。
2. 输入普通聊天，确认正常行为。
3. 输入 `@codex inspect`，确认消息不进入服务端聊天且本地显示 Phase 0 回显。
4. 输入 `!codex status`，确认同样被拦截。

本次状态：资源下载阻塞，待补。

### P0-06 Java ↔ Node WebSocket

```powershell
Push-Location phase0\gateway-probe
npm install
$env:PHASE0_GATEWAY_TOKEN = 'temporary-test-token'
node server.mjs
```

另一个终端：

```powershell
javac GatewayWebSocketProbe.java
java GatewayWebSocketProbe ws://127.0.0.1:25600/ws temporary-test-token
```

通过条件：输出 `JAVA_WEBSOCKET_PROBE_OK`。本次已通过。

### P0-07 Codex app-server 握手

```powershell
node phase0\app-server-probe.mjs
```

通过条件：返回 `ok=true`、Windows platform 和 threadId。本次已通过。

### P0-08 Codex 加载 MCPFabric

```powershell
node phase0\app-server-mcp-probe.mjs
```

通过条件：`runtimeStatus=connected`、`version=0.9.1`、toolCount 非零。本次实际为 105，已通过。

### P0-09 世界读写与恢复

1. 启动 MCPFabric `:1.21.11:runServer` 或实际客户端单人世界。
2. 用 `PHASE0_MCP_TOOL=get_status` 检查版本和 serverPresent。
3. 读取测试坐标旧状态。
4. 写入明确的临时方块。
5. 再次读取确认。
6. 恢复旧状态。
7. 正常退出游戏，确认发现文件删除。

本次使用 `(0,200,0)`，`air → gold_block → air`，已通过。

### P0-10 安全负向测试

进入 Phase 1 前自动化以下用例：

1. 无 bearer token 的 `/rpc` 返回 401。
2. 错误 token 返回 401。
3. `readToken` 调用 `world.setBlock` 返回 403。
4. 带 `Origin` 的请求返回 403。
5. 非 `application/json` 的 `/rpc` 返回 415。
6. 停止游戏后发现文件删除。
7. `enableWorldWrite=false` 时写工具失败。
8. `enablePlayerControl=false` 时移动/交互工具失败，但 `get_self` 仍可读取。

其中 1-5 和 read-only method 映射已由 MCPFabric 上游测试覆盖；Phase 1 应增加本项目级集成测试。

## 13. Phase 0 状态

Phase 0 的技术可行性验证已完成。可以进入 Phase 1，但建议先在网络可下载 Minecraft assets 的环境中执行一次 P0-05 GUI 手工烟测。

在收到确认前，不继续开发 Phase 1。
