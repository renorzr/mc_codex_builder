# Minecraft Codex Builder

Minecraft Java Edition AI 建造助手。最终目标是在 Windows 游戏聊天框输入指令，由 Codex 观察、规划并建造。

**Phase 1 聊天、Phase 2 只读观察和 Phase 3 小型建筑闭环均已完成 Windows + Minecraft 1.21.11 / Fabric 游戏内人工验收。** 仍不开放 NBT、危险方块或无限范围建造；计划内命令使用 Gateway 黑名单过滤，默认拦截管理员、停服、数据包/函数和嵌套执行入口。

Phase 4 已补充任务历史、启动取消、旧审批失效和断线重连验证；本阶段通过 Linux 无游戏检查，Windows 游戏内稳定性验收尚待完成，见 [Phase 4 报告](PHASE4_REPORT.md)。

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
!codex history 10
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

随后运行 `npm run chat`。真实后端会使用账户模型额度。默认聊天模式的 Thread 使用独立工作目录、只读沙箱和聊天限制，关闭已配置的 MCP、插件等工具入口，并拒绝交互式工具审批。没有世界接入时不会声称完成游戏操作。

## 只读世界观察（Phase 2）

复制并编辑 `config/gateway.observe.example.json`，将 `world.mcpServerPath` 设置为本地 MCPFabric MCP Server 的 `dist/index.js` 路径，使用 `GATEWAY_CONFIG=<配置文件> npm run dev` 启动。需要 MCPFabric 客户端 Mod、已进入的单人世界，以及区域和视觉读取能力。

```text
@codex 分析我周围的场景，告诉我坐标、朝向和附近有哪些方块，并检查截图。
```

此模式只开放八个读取工具，不开放建造、命令执行或玩家控制。接入步骤与限制见 [开发说明](development.md#只读世界观察phase-2)，本机证据见 [Phase 2 报告](PHASE2_REPORT.md)。

## 小型建筑与审批（Phase 3）

使用 `config/gateway.build.example.json` 配置入口文件并显式开启 `building.enabled`，完成游戏端能力配置后启动 Gateway。默认允许附近主世界的任意合法方块 ID（使用默认方块状态），最多改变 2048 格。结构化计划可先执行未被黑名单拦截的命令（如 `clone`），再执行方块摆放或替换。

```text
@codex 在我前方空地上方建一个 5×5、高 6 格的石砖小塔，保留内部空气。
!codex status
!codex approve
# 或 !codex reject
# 需要指定任务时：!codex approve <task-id>
```

模型只生成计划。Gateway 显示坐标、材料和实际改变数量，等待明确确认后才按固定计划分批执行，逐批读回并最终检查区域；建造后不再额外启动视觉复核模型。拒绝、切换世界或配置的过期时间会使旧审批失效；中断不自动回滚已生效方块。详细配置与边界见 [开发说明](development.md#小型建筑与审批phase-3)。

## 验证

```bash
npm test                  # TypeScript 构建、协议、Gateway 和 Codex 适配器测试
npm run smoke             # 真实 WebSocket + 模拟回复，两轮往返
npm run test:java         # Java 单元测试 + Java ↔ Node 实际 WebSocket 通信
npm run smoke -- --codex  # 可选：真实 Codex 两轮聊天，使用账户额度
npm run smoke:observe     # 真实 app-server + MCP 模拟世界；不发起模型推理
npm run smoke:observe -- --model # 可选：模型实际读取模拟世界与图片
npm run smoke:build       # Gateway + 模拟协议后端，确认前后写入验证
npm run smoke:build -- --model # 可选：真实模型 + MCP 模拟世界，使用账户额度
npm run smoke:stability   # 强制终止并重启独立 Gateway；历史保留，旧审批失效，无任务重放
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
- [Phase 2 只读观察报告](PHASE2_REPORT.md)：读取接入、权限限制、无游戏与游戏内验证。
- [Phase 3 建造报告](PHASE3_REPORT.md)：具体计划审批、固定执行器、模拟验证与真实游戏验收。
- [Phase 4 稳定性报告](PHASE4_REPORT.md)：任务历史、崩溃恢复边界、启动取消与 Java 重连。
- [MVP 技术设计](MVP_DESIGN.md)、[Phase 0 历史验证报告](PHASE0_REPORT.md)。
- `packages/gateway`：Node.js/TypeScript Gateway、mock/真实 Codex 后端、终端客户端。
- `packages/shared`：协议校验、任务类型、命令解析。
- `phase0/companion-mod`：已扩展为 Phase 1 的 Fabric 客户端 Mod，保留原路径。
- `phase0/gateway-probe`、`phase0/app-server*.mjs`、`phase0/evidence`：历史探针与证据。

所有服务仅监听 `127.0.0.1`，HTTP/WebSocket 均需 bearer token。运行数据和 token 存于忽略提交的 `.local/`；不要提交游戏配置、世界、日志或凭证。

License：[MIT](../LICENSE)。
