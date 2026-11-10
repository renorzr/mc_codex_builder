# Minecraft Codex Builder — MVP 技术设计与开发任务书

> 实现进度（2026-11-10）：[Phase 1](PHASE1_REPORT.md) 聊天链路和 [Phase 2](PHASE2_REPORT.md) 只读世界观察均已完成 Windows + Minecraft 1.21.11 / Fabric 游戏内验收。下文保留原始设计；当前协议以 [protocol.md](protocol.md) 为准，Companion 继续使用 `phase0/companion-mod` 路径。建造和建筑审批仍待后续实现。

## 1. 项目目标

开发一个运行在 Windows 本机的 Minecraft AI 建造助手。

用户可以直接在 Minecraft Java Edition 的聊天窗口输入自然语言指令，由后台 Codex Agent 理解任务、读取当前 Minecraft 世界、规划建筑并执行方块操作。

### 1.1 目标使用体验

用户在 Minecraft 中输入：

```text
@codex 在我面前建一栋三层教学楼，白色墙壁，蓝色屋顶，每层都有窗户。
```

系统自动执行：

1. 接收 Minecraft 聊天指令。
2. 将任务提交给 Codex。
3. Codex 读取当前玩家位置、朝向和周围场景。
4. Codex 制定建筑方案。
5. 展示建筑位置、尺寸和修改范围。
6. 等待用户确认。
7. Codex 调用 Minecraft MCP 工具执行建造。
8. 检查建造结果。
9. 将执行进度和结果反馈到 Minecraft 聊天窗口。

用户不需要切换到 Codex CLI 窗口操作。

### 1.2 本 MVP 的核心目标

必须实现：

- Minecraft 游戏内聊天指令入口。
- Codex 长期会话管理。
- Minecraft 世界状态读取。
- Minecraft 方块批量建造。
- 建造前确认机制。
- 任务执行进度反馈。
- 建造结果验证。
- 基本错误处理和任务中断。

## 2. 技术选型

### 2.1 运行环境

| 项目 | 技术 |
|---|---|
| 操作系统 | Windows 10/11 |
| Minecraft | Java Edition 1.21.11 |
| Minecraft Mod Loader | Fabric |
| Minecraft 世界操作 | MCPFabric |
| 游戏内交互 | 自研 Fabric Companion Mod |
| Gateway | Node.js + TypeScript |
| Codex 集成 | Codex app-server |
| AI 工具协议 | MCP |
| 本地通信 | HTTP + WebSocket |
| 配置格式 | JSON |

### 2.2 架构原则

1. Companion Mod 负责 Minecraft 客户端交互。
2. MCPFabric 负责已有的世界观察和修改能力。
3. Gateway 负责消息路由、任务队列和会话管理。
4. Codex app-server 负责 AI 推理和工具调用。
5. Codex 通过 MCPFabric MCP Server 操作 Minecraft。
6. 各组件独立运行，通过明确的协议通信。

不要在 Companion Mod 中实现建筑规划或 AI 推理。

不要在 Gateway 中重新实现方块操作。

不要直接通过模拟键盘和鼠标操作 Minecraft。

### 2.3 依赖验证要求

开发前必须检查以下上游项目：

- MCPFabric 的 1.21.11 兼容版本。
- MCPFabric 实际提供的 MCP 工具列表。
- MCPFabric 的 Bridge 发现机制和认证方式。
- MCPFabric 是否提供主动发送游戏聊天消息的接口。
- Fabric API 对 1.21.11 的客户端聊天事件接口。
- Codex app-server 当前版本的启动参数、JSON-RPC 协议和事件格式。

不得根据 README 中的示例猜测实际 API。

必须检查源码、实际版本和运行行为。

如果 MCPFabric 的接口与设计假设不一致，应先编写适配层，不要修改上游项目源码。

## 3. 系统架构

```text
┌───────────────────────────────────────┐
│          Minecraft Java Client        │
│                                       │
│  ┌─────────────────────────────────┐  │
│  │ Minecraft Codex Companion Mod   │  │
│  │                                 │  │
│  │ - Chat Command Interceptor      │  │
│  │ - Chat Message Display          │  │
│  │ - Gateway Connection            │  │
│  │ - Player Context                │  │
│  └───────────────┬─────────────────┘  │
└──────────────────┼────────────────────┘
                   │
             WebSocket / HTTP
                   │
┌──────────────────▼────────────────────┐
│             Node.js Gateway           │
│                                       │
│  - Chat Command Parser                │
│  - Task Queue                         │
│  - Task State Manager                 │
│  - Codex Session Manager              │
│  - Event Dispatcher                   │
│  - Chat Reporter                      │
└──────────────────┬────────────────────┘
                   │
             JSON-RPC / stdio
                   │
┌──────────────────▼────────────────────┐
│            Codex app-server           │
│                                       │
│  - Persistent Thread                  │
│  - Task Execution                     │
│  - MCP Tool Calls                     │
└──────────────────┬────────────────────┘
                   │
                   │ MCP
                   │
┌──────────────────▼────────────────────┐
│             MCPFabric Server          │
│                                       │
│  - World Observation                  │
│  - Block Query                        │
│  - Block Modification                 │
│  - Screenshot                         │
│  - Player State                       │
└──────────────────┬────────────────────┘
                   │
                   ▼
             Minecraft World
```

## 4. 项目目录

采用 Monorepo：

```text
minecraft-codex-builder/
│
├── packages/
│   │
│   ├── companion-mod/
│   │   ├── src/main/java/
│   │   │   └── ... 
│   │   ├── src/main/resources/
│   │   └── build.gradle
│   │
│   ├── gateway/
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── server.ts
│   │   │   ├── chat-parser.ts
│   │   │   ├── task-queue.ts
│   │   │   ├── task-manager.ts
│   │   │   ├── codex-session.ts
│   │   │   ├── codex-client.ts
│   │   │   ├── event-dispatcher.ts
│   │   │   ├── chat-reporter.ts
│   │   │   └── config.ts
│   │   └── package.json
│   │
│   └── shared/
│       └── src/
│           ├── protocol.ts
│           ├── task.ts
│           └── events.ts
│
├── config/
│   └── gateway.example.json
│
├── docs/
│   ├── README.md
│   ├── MVP_DESIGN.md
│   ├── PHASE0_REPORT.md
│   ├── PHASE1_REPORT.md
│   ├── architecture.md
│   ├── protocol.md
│   └── development.md
│
├── scripts/
│
├── AGENTS.md
└── package.json
```

具体 Java 包名、Gradle 插件版本和 Fabric API 版本由开发时验证的 Minecraft 1.21.11 依赖决定。

## 5. Companion Mod 设计

### 5.1 职责

Companion Mod 是游戏与外部 Gateway 之间的桥梁。

负责：

- 监听用户输入的聊天指令。
- 拦截 `@codex` 和 `!codex` 消息。
- 将消息发送给 Gateway。
- 接收 Gateway 返回的状态和消息。
- 在 Minecraft 聊天 HUD 中显示结果。
- 提供当前客户端连接状态。

不负责：

- Codex 推理。
- 建筑规划。
- 批量方块操作。
- 任务调度。

### 5.2 聊天指令拦截

支持：

```text
@codex <自然语言任务>
```

例如：

```text
@codex 在我面前建一座石砖塔
@codex 把刚才的建筑改成白色
@codex 分析当前场景
```

拦截要求：

1. 只拦截本地玩家主动输入的消息。
2. 识别 `@codex` 前缀。
3. 命中后取消原始聊天消息发送。
4. 将命令发送给 Gateway。
5. 普通聊天消息保持原有行为。
6. Gateway 返回的消息只显示在本地 HUD，不再次发送给服务器。

`!codex` 用于系统控制命令。

例如：

```text
!codex status
!codex stop
!codex help
!codex approve <task-id>
!codex reject <task-id>
```

不要依赖定时扫描聊天历史作为主要输入方式。

优先使用 Fabric 客户端聊天发送事件，在消息发往服务器之前进行拦截。

### 5.3 游戏内消息显示

统一使用以下格式：

```text
[Codex] 已连接。
[Codex] 收到任务，正在分析场景……
[Codex] 建筑方案已生成。
[Codex] 等待你的确认。
[Codex] 正在建造……
[Codex] 建造完成。
```

消息显示必须运行在 Minecraft Client Thread。

Gateway 网络回调不能直接修改 Minecraft 客户端对象。

### 5.4 连接管理

Companion Mod 启动时：

1. 检测本地 Gateway。
2. 建立 WebSocket 连接。
3. 完成身份验证。
4. 发送客户端状态。
5. 定期发送心跳。
6. Gateway 不可用时进行有限次数重连。

游戏退出或切换世界时通知 Gateway。

切换世界后，不允许继续执行针对旧世界的待执行任务。

## 6. Gateway 设计

Gateway 是整个系统的核心协调组件。

### 6.1 HTTP / WebSocket 服务

仅监听：

```text
127.0.0.1
```

建议：

```text
HTTP:      127.0.0.1:25600
WebSocket: 127.0.0.1:25600/ws
```

使用随机生成的本地访问 Token。

所有 HTTP 和 WebSocket 请求均进行身份验证。

不要开放到公网或局域网。

### 6.2 Gateway 接口

#### Companion Mod → Gateway

```text
POST /api/chat/command
```

请求：

```json
{
  "messageId": "uuid",
  "text": "在我面前建一座石砖塔",
  "player": {
    "name": "Player"
  },
  "world": {
    "dimension": "minecraft:overworld"
  }
}
```

返回：

```json
{
  "accepted": true,
  "taskId": "task-001"
}
```

注意：玩家位置、朝向等权威数据应由 MCPFabric 在任务执行时重新读取，不能信任聊天消息中附带的旧数据。

#### Gateway → Companion Mod

通过 WebSocket 推送：

```json
{
  "type": "task.status",
  "taskId": "task-001",
  "status": "running",
  "message": "正在建造地基"
}
```

其他消息：

```json
{
  "type": "chat.message",
  "level": "info",
  "text": "建筑方案已生成，请确认。"
}
```

```json
{
  "type": "task.completed",
  "taskId": "task-001",
  "summary": "石砖塔建造完成"
}
```

```json
{
  "type": "task.failed",
  "taskId": "task-001",
  "error": "Minecraft 世界连接已断开"
}
```

### 6.3 任务队列

MVP 采用单任务串行执行。

不允许多个 Codex 建造任务同时修改世界。

任务状态：

```text
QUEUED
  ↓
OBSERVING
  ↓
PLANNING
  ↓
AWAITING_APPROVAL
  ↓
BUILDING
  ↓
VERIFYING
  ↓
COMPLETED
```

异常状态：

```text
FAILED
CANCELLED
```

规则：

- 同一时间最多执行一个建造任务。
- 新任务进入队列。
- 用户可以查看当前任务。
- 用户可以取消待执行任务。
- 取消运行中任务时，尝试中断 Codex turn。
- 任务取消后，不再执行新的 Minecraft 修改操作。
- 已经执行的方块修改不自动回滚，除非后续实现可靠的撤销机制。

不要在 Gateway 中并发启动多个 Codex turn 来处理同一个 Minecraft 世界。

## 7. Codex 集成

### 7.1 使用 Codex app-server

通过 app-server 的 JSON-RPC stdio 协议管理 Codex。

不要每收到一条 Minecraft 消息就重新启动一次 Codex CLI。

Gateway 应维护一个长期运行的 app-server 进程和一个持久 Thread。

启动时：

1. 检测 Codex CLI 是否存在。
2. 启动 `codex app-server`。
3. 完成 initialize 握手。
4. 创建或恢复 Thread。
5. 等待 Minecraft 任务。

实际 JSON-RPC 初始化、Thread 创建、Turn 启动、事件读取和中断方法必须以当前安装版本的 app-server 文档为准。

不要自行猜测 JSON-RPC 方法名称和参数。

### 7.2 MCP 配置

Codex 使用 MCPFabric 已有的 MCP Server。

Codex Thread 启动后应能使用 Minecraft MCP 工具。

开发时验证实际工具清单。

至少需要具备：

- 玩家状态读取。
- 世界状态读取。
- 指定区域方块读取。
- 场景截图。
- 指定方块修改。
- 区域批量填充。

如果实际 MCP 工具名称不同，以实际工具清单为准。

### 7.3 Codex 工作目录

为 Codex 建立专门的项目工作目录：

```text
minecraft-codex-workspace/
├── AGENTS.md
├── plans/
├── history/
└── structures/
```

Codex 在该目录工作。

不要允许 Codex 任意修改 Gateway、Companion Mod 的源代码作为普通建造任务的一部分。

### 7.4 AGENTS.md

Codex 应遵循以下工作规则：

- 先读取玩家状态和世界信息。
- 先观察目标区域，再制定建筑计划。
- 建造前说明坐标和修改范围。
- 未确认之前不执行大规模写入。
- 优先批量操作。
- 保留目标区域外的现有建筑。
- 建造后读取方块数据验证。
- 使用截图检查视觉结果。
- 出现错误时停止后续修改并报告。
- 不得假定 MCP 操作已经成功，必须检查结果。

## 8. 建筑执行流程

### 8.1 场景观察

Codex 首先调用 MCP 工具获取：

- 玩家位置。
- 玩家朝向。
- 当前维度。
- 当前游戏模式。
- 目标区域方块。
- 当前场景截图。

如果无法获取必要信息，应停止规划并报告。

### 8.2 建筑规划

将用户的自然语言需求转换为结构化建筑计划。

示例：

```json
{
  "name": "stone_tower",
  "origin": {
    "x": 120,
    "y": 65,
    "z": 230
  },
  "size": {
    "width": 7,
    "height": 10,
    "depth": 7
  },
  "materials": [
    "minecraft:stone_bricks",
    "minecraft:glass_pane"
  ],
  "operations": []
}
```

具体方块操作由 Codex 根据 MCP 工具能力生成。

MVP 不要求实现独立的建筑 DSL 编译器。

### 8.3 建造确认

建造前在聊天窗口显示：

```text
[Codex] 建筑方案：

类型：石砖塔
位置：(120, 65, 230)
尺寸：7 × 10 × 7
预计修改范围：588 个方块

输入 !codex approve task-001 确认。
输入 !codex reject task-001 取消。
```

实际修改方块数量应由建筑计划计算，不要使用简单的包围盒体积代替。

只有用户确认后才开始执行。

小范围读取和规划不需要确认。

### 8.4 执行建造

优先使用批量填充工具。

建议按照以下顺序：

1. 地基。
2. 主体结构。
3. 墙壁。
4. 门窗。
5. 屋顶。
6. 装饰。

每个阶段结束后发送进度消息。

不要为每个方块单独向 Minecraft 聊天窗口发送消息。

### 8.5 建造验证

建造完成后：

1. 重新读取目标区域。
2. 检查关键位置的方块。
3. 检查是否有明显遗漏。
4. 获取新截图。
5. 向用户报告结果。

MVP 不要求实现复杂的图像识别评分系统。

## 9. 聊天命令

支持以下命令：

| 命令 | 功能 |
|---|---|
| `@codex <任务>` | 创建 AI 任务 |
| `!codex status` | 查看当前任务 |
| `!codex queue` | 查看排队任务 |
| `!codex stop` | 中断当前任务 |
| `!codex approve <id>` | 确认执行 |
| `!codex reject <id>` | 拒绝任务 |
| `!codex help` | 显示帮助 |

MVP 暂不实现复杂的自然语言多轮编辑命令解析。

自然语言对话全部交给 Codex Thread。

## 10. 安全要求

### 10.1 网络安全

- Gateway 只绑定 localhost。
- 使用随机 Token。
- 不开放外网访问。
- 不允许未经验证的客户端提交任务。

### 10.2 Minecraft 操作安全

- 默认只允许单人世界或明确授权的本地世界。
- 进入新世界时重新建立世界会话。
- 切换世界时中断旧任务。
- 不允许默认执行大范围地形清除。
- 大规模覆盖、拆除需要确认。
- 不允许未经用户明确要求修改其他建筑。
- 不允许自动执行任意 Minecraft 命令。
- 所有写入操作必须来自当前已确认的任务。

### 10.3 用户权限

MVP 只接受本地玩家主动输入的 `@codex` 指令。

不允许其他服务器玩家通过聊天消息直接触发本地 Codex。

Companion Mod 应在客户端拦截用户主动发送的消息，而不是把所有服务器聊天消息都当作任务入口。

### 10.4 Codex 权限

不要通过关闭所有 Codex 审批或设置不受限制的执行模式来简化实现。

MCP 工具的写入确认由 Gateway 的任务审批流程管理。

Codex 的文件系统和其他工具权限仍遵循用户现有配置。

## 11. 配置文件

Gateway 配置：

```json
{
  "host": "127.0.0.1",
  "port": 25600,
  "auth": {
    "enabled": true
  },
  "codex": {
    "command": "codex",
    "args": ["app-server"],
    "startupTimeoutMs": 30000
  },
  "tasks": {
    "maxConcurrent": 1,
    "requireApproval": true
  },
  "chat": {
    "prefix": "@codex",
    "statusPrefix": "!codex"
  }
}
```

Token 应单独存储，不要提交到 Git。

实际配置项应由代码中的配置 Schema 验证。

## 12. 开发阶段划分

### Phase 0：依赖验证

目标：验证技术路线是否可行。

任务：

1. 检查 MCPFabric 1.21.11 版本。
2. 安装并运行 Fabric Companion Mod 开发环境。
3. 验证 Minecraft 聊天拦截。
4. 验证 MCPFabric Bridge 连接。
5. 验证 Codex app-server 启动。
6. 验证 Codex 能调用 Minecraft MCP 工具。
7. 验证 Minecraft 方块修改。

交付：

- 依赖版本记录。
- 可运行的最小测试。
- 接口说明。
- 风险清单。

### Phase 1：聊天闭环

目标：从 Minecraft 聊天窗口向 Codex 提交任务，并收到回复。

实现：

1. Companion Mod。
2. Gateway HTTP / WebSocket。
3. Codex app-server 客户端。
4. 持久 Thread。
5. 任务队列。
6. 状态消息回传。

测试：

```text
@codex 请介绍一下你能做什么
```

预期 Codex 回复出现在 Minecraft 聊天窗口。

这一阶段不要求修改世界。

### Phase 2：世界观察

目标：Codex 能理解当前 Minecraft 场景。

测试：

```text
@codex 分析我周围的场景，告诉我当前坐标和附近有哪些建筑。
```

Codex 应该能够：

- 获取玩家坐标。
- 获取玩家朝向。
- 获取周围方块信息。
- 获取游戏截图。
- 总结当前场景。

### Phase 3：建筑执行

目标：实现完整建造闭环。

测试：

```text
@codex 在我前方建造一个 5×5 的石砖小塔，高度 6 格。
```

执行流程：

观察 → 规划 → 确认 → 建造 → 验证 → 汇报。

### Phase 4：稳定性完善

实现：

- Gateway 断线重连。
- Codex 异常退出恢复。
- 游戏退出检测。
- 世界切换检测。
- 任务中断。
- 任务日志。
- 失败处理。
- 基本单元测试和集成测试。

## 13. MVP 验收标准

以下全部通过才算 MVP 完成。

### A. 游戏内交互

- [ ] 可以在 Minecraft 聊天窗口输入 `@codex`。
- [ ] 普通聊天不受影响。
- [ ] 指令不会广播给其他服务器玩家。
- [ ] Codex 回复能显示在游戏聊天窗口。
- [ ] 支持任务状态查询。
- [ ] 支持停止任务。

### B. Codex 集成

- [ ] Gateway 可以启动 Codex app-server。
- [ ] Codex Thread 可以持续复用。
- [ ] Codex 可以调用 MCPFabric 工具。
- [ ] Codex 输出和任务事件可以反馈给 Gateway。
- [ ] Codex 断开后可以恢复。

### C. Minecraft 场景理解

- [ ] 能获取当前玩家坐标。
- [ ] 能获取玩家朝向。
- [ ] 能读取指定区域的方块。
- [ ] 能获取当前游戏截图。
- [ ] 能根据读取结果描述周围环境。

### D. 建造能力

- [ ] 能根据自然语言生成建筑计划。
- [ ] 能显示建筑位置和尺寸。
- [ ] 建造前需要用户确认。
- [ ] 能批量放置方块。
- [ ] 能读取修改后的区域。
- [ ] 能验证建造结果。

### E. 安全性

- [ ] Gateway 仅监听 localhost。
- [ ] 网络通信有身份验证。
- [ ] 不允许其他玩家触发本地 Codex。
- [ ] 切换世界时旧任务中断。
- [ ] 未确认的建筑计划不会修改世界。
- [ ] 失败时不会继续执行后续写入。

## 14. 暂不实现的功能

以下全部不属于 MVP：

- Windows 安装器。
- 自动安装 Fabric。
- 照片转 Minecraft 建筑。
- 三维模型导入。
- 建筑 DSL 编译器。
- 建筑可视化编辑器。
- 复杂撤销和版本管理。
- 多 Agent 协作。
- 多世界并行。
- 多人服务器远程控制。
- 语音交互。
- Web 管理后台。

不要为了这些功能提前引入复杂架构。

## 15. 给 Codex 的执行要求

请按以下原则开展开发：

1. 首先阅读并验证上游项目源码和实际依赖。
2. 先完成 Phase 0，不要直接开始大规模编码。
3. 建立明确的模块边界和共享协议。
4. 每个 Phase 完成后运行测试并记录结果。
5. 优先保证 Windows 本机运行。
6. 不要虚构 MCP 工具名称和参数。
7. 不要假设 Fabric API 事件名称与其他版本相同。
8. 不要假设 Codex app-server 协议与普通 Codex CLI 命令相同。
9. 所有异步事件和游戏线程操作必须正确处理。
10. 对无法验证的功能明确标注，不得用模拟结果代替真实集成测试。

### 最终交付物

- 可构建的 Companion Mod。
- 可运行的 Node.js Gateway。
- Codex app-server 集成。
- MCPFabric 接入。
- 完整配置示例。
- README。
- 开发环境搭建说明。
- 自动化测试。
- 手动集成测试清单。

第一优先级不是功能数量，而是完成：

**Minecraft 聊天输入 → Codex → MCPFabric → Minecraft 建造 → 游戏内结果反馈。**
