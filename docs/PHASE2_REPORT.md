# Phase 2：只读世界观察接入

日期：2026-11-10。开发基线：`76ac07b`，已包含 Windows Codex 启动修复与 Phase 1 游戏内验收记录。

## 结论

已实现可选的 MCPFabric 只读观察模式，并在本机完成真实 Codex app-server、MCP stdio、模型工具调用及故障处理测试。默认配置仍是 Phase 1 聊天模式。

**2026-11-10 已在 Windows 11 + Minecraft 1.21.11 + Fabric 环境中完成游戏内只读观察人工验收。** 本次验收使用真实单人集成世界；模拟坐标、模拟方块和占位图片仅作为自动化测试证据，不作为真实世界验收证据。建造、建筑审批、命令执行和玩家控制未开放。

## 实现

- `world.enabled` 显式开启观察，要求 `backend=codex` 和本地 MCP Server 入口文件。
- 专用 `mccodex_observe` stdio 服务、独立 `codex-observe-workspace`，不修改用户全局配置。
- 其他 MCP、shell、插件、apps、浏览器和电脑工具入口维持关闭，只读沙箱与既有审批策略保留。
- 上游 `world,player,vision,readonly` 过滤器与 Codex `enabled_tools` 白名单配合，限定八个工具。
- 每轮任务在模型推理前重新检查 MCP 连接、工具目录、游戏状态和玩家状态；丢弃不需要的返回字段。
- 缺工具、未知只读属性、游戏未启动、无集成世界、AI 暂停、无视觉能力和玩家状态无效时明确失败，不启动本轮推理。
- 玩家位置、朝向、维度和模式来自当前 MCPFabric 返回，作为本次观察数据提供给模型；不会从客户端消息中接受这些权威字段。
- 区域读取和截图通过真实 MCP 工具交给模型，进度回到现有 Companion/终端文字通道。
- 运行中工具错误、越过允许工具范围时停止该轮，等待子进程退出；已缓存的完成通知不会把失败任务改判为成功。
- 预检期间取消会结束子进程，再释放串行队列；既有世界切换和断开取消逻辑继续适用。
- `gateway.hello` 与 `/health` 增加模式信息；`writesEnabled` 始终是 false。Mod 欢迎消息可显示“世界观察，只读”。

## 工具范围与来源

八项读取工具为 `get_status`、`list_capabilities`、`get_self`、`get_block`、`get_blocks_region`、`find_blocks`、`screenshot`、`describe_scene`。

源码依据为 MCPFabric commit `a49a10641af2da813bb965e09114f7052c25ab35` 的 [工具目录](https://github.com/denfry/mcpfabric/blob/a49a10641af2da813bb965e09114f7052c25ab35/mcp-server/src/tools.ts)、[工具过滤器](https://github.com/denfry/mcpfabric/blob/a49a10641af2da813bb965e09114f7052c25ab35/mcp-server/src/toolsets.ts)、`InfoHandlers.java` 与 `LocalPlayerHandlers.java`。本次实际克隆并检查该 commit，未修改上游源码。

Codex 依据[官方 MCP 配置说明](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)和[app-server 文档](https://learn.chatgpt.com/docs/app-server)，以及本机 `codex-cli 0.167.0` 生成的类型。新增的工具状态、工具调用 DTO 也来自生成器。

## 本机验证

环境：Linux x86_64、Node.js 24.19.0、OpenJDK 21.0.12.1、Codex CLI 0.167.0。

| 检查 | 实际结果 | 证明范围 |
|---|---|---|
| `npm test` | 31 项：30 通过、1 Windows 专用项跳过 | 新增 15 项观察测试，以及既有协议、队列和进程测试；没有在 Linux 重验 Windows shim |
| `npm run smoke` | 两轮往返通过 | 原 mock Gateway 聊天链路保持可用 |
| `npm run smoke:observe` | 通过 | 真实 app-server 连接 MCP 模拟服务，读取玩家/区域 JSON 和图片；未发起模型推理 |
| `npm run smoke:observe -- --model` | 通过 | 真实模型实际调用 `get_blocks_region` 和 `screenshot`，根据模拟数据回复并注明模拟来源 |
| `npm run smoke:observe -- --model-error` | 通过 | 模拟截图返回工具错误后，Gateway 停止实际模型回合并使任务失败 |
| 固定上游 MCP Server | 编译通过，无游戏时明确拒绝观察 | 真正的 MCPFabric stdio 目录通过预检，Bridge 不可达时在 `get_status` 阶段失败，没有启动模型 Turn |
| `npm run test:java` | 6 项 JUnit 与 Java ↔ Node 烟测通过 | 游戏无关 Java 逻辑与现有通信未受影响 |
| `./gradlew test build --no-daemon` | 构建通过、7 项 JUnit 通过 | 完整 Fabric Mod 可编译、测试和打包 |

MCP 模拟服务的 Schema 快照直接取自上述上游工具目录，并额外包含 `get_inventory`、`set_block` 用于检查白名单。真实 app-server 拒绝这两项非白名单调用，MCP 服务日志确认它们没有被转发。诊断适配器也会在本地拒绝写工具。

模拟状态为 `(10, 65, 20)`、`minecraft:overworld`、creative，区域只返回两块 `minecraft:stone_bricks`；图片是明确标注的 1×1 占位图。它证明图片传输与工具调用链路，不证明游戏截图质量或真实建筑识别。

固定上游的依赖和编译产物仅在忽略提交的 `.phase0/upstream/mcpfabric` 中；测试临时目录会清理，未保存 Bridge token、游戏世界或模型原始日志。

## 游戏内人工验收

2026-11-10 在 Windows 11、Minecraft 1.21.11、Fabric Loader 0.20.1、Fabric API 0.141.6+1.21.11、MCPFabric 0.9.1+1.21.11 环境中，由维护者使用真实单人集成世界确认通过：

| 检查项 | 结果 |
|---|---|
| 欢迎消息显示“世界观察，只读”，MCP 预检通过 | 通过 |
| 坐标、朝向、维度和游戏模式与当前玩家一致，移动后新任务重新读取 | 通过 |
| 实际区域方块和截图能传给模型，截断或无法确定的结果被明确说明 | 通过 |
| 游戏退出、视觉能力关闭或 chunk 未加载时明确失败，不继续宣称成功 | 通过 |
| 建造、命令和移动请求不会执行，`approve/reject` 不放行写入 | 通过 |

## 限制与下一步

1. Phase 2 已完成真实 Windows/Minecraft 单人集成世界验收；其他 Minecraft/Fabric 版本、dedicated server 或普通多人服务器仍需单独验证。
2. 当前仅支持客户端与本地集成世界；单独 dedicated server 或普通多人服务器不满足完整观察前提。
3. 本次预检数据代表读取时刻；玩家可在模型处理期间移动，不是跨多个工具调用的原子世界快照。
4. `worldSessionId` 仍不是可信世界身份，不能用于后续写权限。建造审批必须另行实现。
5. 指引要求初始扫描半径 ≤8、返回 ≤4096 块；这是模型指引，实际扫描边界由上游约束。图片 JSON-RPC 最大 16 MiB，超出时任务失败。
6. 游戏内文本、标牌和截图按不可信观察数据处理。当前不提供独立的建筑 DSL、撤销或自动写入能力。
