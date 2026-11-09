# Minecraft Codex Builder

Minecraft Java Edition AI 建造助手。最终目标是在 Windows 游戏聊天框输入指令，由 Codex 观察、规划并建造。

**目前已实现 Phase 1 聊天链路，可在 Linux、无 Minecraft 的环境开发和测试。** 世界观察、建造、建筑审批尚未开放；游戏内交互仍需客户端烟测，不能视为完整 MVP。

## 无游戏启动

需要 Node.js ≥22.16；Java 部分需要 JDK 21。以下命令均从仓库根目录执行。

```bash
npm ci
npm run dev
```

默认启动 **mock 后端**，只返回明确标注的模拟回复，不需要 Codex 登录或 Minecraft。另开终端：

```bash
npm run chat
```

输入：

```text
@codex 你好
!codex status
!codex queue
!codex stop
!codex help
```

终端中的 `/world` 模拟切换世界，取消旧会话任务；`/quit` 退出。Gateway 同时只接受一个客户端，运行终端时请勿同时连接 Mod。

## 真实 Codex 聊天

使用已有 Codex 登录；适配器的协议定义由本机 **codex-cli 0.167.0** 生成。

Linux/macOS：

```bash
GATEWAY_BACKEND=codex npm run dev
```

PowerShell：

```powershell
$env:GATEWAY_BACKEND = 'codex'
npm run dev
```

随后运行 `npm run chat`。真实后端会使用账户模型额度。当前 Thread 使用独立工作目录、只读沙箱和聊天限制，关闭已配置的 MCP、插件等工具入口，并拒绝交互式工具审批。没有世界接入时不会声称完成游戏操作。

## 验证

```bash
npm test                  # TypeScript 构建、协议、Gateway 和 Codex 适配器测试
npm run smoke             # 真实 WebSocket + 模拟回复，两轮往返
npm run test:java         # Java 单元测试 + Java ↔ Node 实际 WebSocket 通信
npm run smoke -- --codex  # 可选：真实 Codex 两轮聊天，使用账户额度
```

构建 Companion Mod，无需运行游戏，但需要下载 Gradle、Fabric 和 Minecraft 编译依赖：

```bash
cd phase0/companion-mod
bash gradlew test build --no-daemon
```

Windows 使用 `gradlew.bat test build --no-daemon`。游戏目录中的 `config/minecraft-codex.json` 可用 `npm run companion:config -- <目标文件路径>` 生成；需先启动一次 Gateway 生成 token。

## 文档与目录

- [开发说明](development.md)：Linux/Windows 命令、配置、测试与联调边界。
- [通信协议](protocol.md)：版本、认证、任务状态、会话生命周期和幂等范围。
- [Phase 1 本机开发报告](PHASE1_REPORT.md)：本次实现和实际验证记录。
- [MVP 技术设计](MVP_DESIGN.md)、[Phase 0 历史验证报告](PHASE0_REPORT.md)。
- `packages/gateway`：Node.js/TypeScript Gateway、mock/真实 Codex 后端、终端客户端。
- `packages/shared`：协议校验、任务类型、命令解析。
- `phase0/companion-mod`：已扩展为 Phase 1 的 Fabric 客户端 Mod，保留原路径。
- `phase0/gateway-probe`、`phase0/app-server*.mjs`、`phase0/evidence`：历史探针与证据。

所有服务仅监听 `127.0.0.1`，HTTP/WebSocket 均需 bearer token。运行数据和 token 存于忽略提交的 `.local/`；不要提交游戏配置、世界、日志或凭证。

License：[MIT](../LICENSE)。
