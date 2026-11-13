# Companion ↔ Gateway 协议 v1

单一双向 WebSocket：`ws://127.0.0.1:25600/ws`。HTTP 只提供认证的 `/health`。这是 Phase 0 实测后选定的方案，取代早期设计中的 HTTP 提交接口。

## 连接与认证

- HTTP/WebSocket 都要求 `Authorization: Bearer <token>`。
- WebSocket 拒绝带 `Origin` 的请求，检查 `Host` 和 `/ws` 路径。
- 同时只接受一个客户端；第二个连接返回 HTTP 409。
- 仅接受 JSON 文本帧，单条消息最大 64 KiB，不启用压缩。
- 每连接最多积压 64 条待处理消息；慢客户端断开。
- 服务端使用 WebSocket ping/pong 检测断线，默认每 15 秒一次。

## Envelope

```json
{
  "protocolVersion": 1,
  "type": "chat.command",
  "messageId": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-11-09T00:00:00Z",
  "payload": {
    "worldSessionId": "session-123",
    "text": "@codex 你好"
  }
}
```

`messageId` 为 UUID。客户端字段严格校验，未知字段、错误版本、空消息、超过 8000 个 UTF-16 单元的指令均拒绝。此通道不传递凭证。时间戳只用于事件记录，不作为防重放或权限依据。

## 消息

| 方向 | type | payload |
|---|---|---|
| 服务端 → 客户端 | `gateway.hello` | `backend`、可选 `mode:chat/observe/build`、`writesEnabled` |
| 客户端 → 服务端 | `client.ready` | `worldSessionId` |
| 服务端 → 客户端 | `client.registered` | `worldSessionId` |
| 客户端 → 服务端 | `chat.command` | `worldSessionId`、`text`（含命令前缀） |
| 客户端 → 服务端 | `client.goodbye` | `worldSessionId` |
| 服务端 → 客户端 | `command.accepted` | `replyTo`、可选 `taskId` |
| 服务端 → 客户端 | `command.error` | 可选 `replyTo`、`code`、`message` |
| 服务端 → 客户端 | `task.status` | `task` 快照 |
| 服务端 → 客户端 | `task.completed` | `task` 快照（含 `result`） |
| 服务端 → 客户端 | `task.failed` | `task` 快照（含 `error`） |
| 服务端 → 客户端 | `task.approval_required` | `task` 快照，含 `build`：世界、坐标、材料、数量、计划指纹与截止时间 |
| 服务端 → 客户端 | `chat.message` | `text`、可选 `taskId` |
| 客户端 → 服务端 | `ping` | `{}` |
| 服务端 → 客户端 | `pong` | `{}` |

使用 `client.ready` 并等待 `client.registered` 后才可提交任务。普通聊天不会送入此通道。服务端最终回复通过 `chat.message` 显示；`task.completed` 用于状态同步，不需再次显示整段回复。

`@codex <文本>` 创建任务。`!codex status/queue/help` 为控制命令，`!codex history [1-50]` 返回最近任务的只读元数据，默认 10 条。`!codex stop [task-id]` 停止运行中、待审批或指定排队任务。只有显式开启建造模式时，`!codex approve [task-id]` 才能确认当前会话里等待审批的计划；`reject [task-id]` 取消计划，省略编号时作用于当前待审批任务。聊天和只读模式仍拒绝这些审批命令。等待审批时 `status` 会重新显示完整确认摘要。

## 任务与生命周期

```text
QUEUED → RUNNING → COMPLETED
             ├→ FAILED
             └→ CANCELLING → CANCELLED
QUEUED → CANCELLED

# 建造模式（普通文字回复仍使用 RUNNING → COMPLETED）
RUNNING → AWAITING_APPROVAL → BUILDING → VERIFYING → COMPLETED
# 任一阶段可失败或取消；待审批会占据串行队列，直到确认、拒绝或过期。
```

所有任务串行执行。取消运行中任务时必须等待后端实际结束；模型回合优先发送 `turn/interrupt`，超时则关闭子进程；初始化、Thread 创建/恢复和预检期间直接关闭子进程，然后才可启动后续任务。失败任务不会自动重试。当前内存任务快照默认最多保留 100 项，新任务优先淘汰已结束快照；没有可淘汰项时拒绝提交。独立的有界任务历史默认保留最近 200 项元数据。

`worldSessionId` 是客户端每次进入世界生成的随机 nonce，**不是权威 Minecraft 世界身份**，不能用于未来写权限校验。新会话、`goodbye`、连接断开会取消全部旧任务，并等待执行结束后重置 Thread；旧事件不会推送到新会话。执行任务和回执只保存在内存，Gateway 重启后不恢复。持久化历史仅含任务编号、会话编号、状态、时间、是否进入写入阶段和可选建造数量/指纹，不含提示词、回复或工具内容。重启发现未完成记录时标为 `INTERRUPTED`，此状态仅用于历史，不是可继续执行的任务状态。

## 幂等与故障

Gateway 保留最近 1024 条会话内命令回执。相同 `worldSessionId + messageId` 且内容完全相同的消息复用原回执，不创建新任务；同 ID 不同内容报错。仍有任务记录时重发当前状态，记录已被清除时返回 `RESULT_EXPIRED`。这不是跨重启、无限期的执行去重保证。

Java 客户端断线后只重连和重新注册，不重发聊天指令。注册响应等待上限 5 秒，文本发送串行且积压上限 16 条。提交结果未知时提示使用 `history` 核查元数据。世界断开后当前任务取消、内存快照清除，持久化历史保留；不能依赖 `status` 或历史恢复已经丢失的正文和执行能力。Gateway/Codex 进程崩溃后不自动重放原任务，Codex 连接结束会使当前待审批计划失败。

当前有 mock 后端和真实 Codex 后端。真实后端默认聊天，可显式启用只读观察或小型建筑。`writesEnabled=true` 只表示当前模式支持审批后的写入，不能当作单个任务已经获准。客户端不提供位置、建筑计划或写参数；这些由 Gateway 从本轮模型输出和 MCPFabric 读取结果校验。计划可为空，或包含最多 16 条按顺序先执行的命令；命令根不能命中 Gateway `blockedCommands`。服务端新增模式和审批推送不改变客户端 envelope；老 Mod 仍可显示文字摘要，但欢迎消息不一定识别新模式。

每份建筑审批绑定任务、客户端会话、当前 `sp:` 世界 ID、维度、目标区域完整状态与计划指纹。审批仅内存持有、单次使用，默认不过期（`approvalTimeoutMs: 0`），配置正数时才启用时间过期；拒绝、过期、退出、切换、重启、Codex 断线或执行失败均不能复用。计划 JSON 文件仅供查看，修改文件不改变内存中的执行内容。执行只使用已校验计划；命令按计划顺序先执行，随后执行方块最终赋值。命令失败即停止，不再执行方块写入。重叠方块操作不会引入未展示的中间写入。

认证 `/health` 在既有 `ok/backend/mode/writesEnabled` 外返回 `history: { enabled, healthy, recovered, retainedEntries }`。日志写入失败时 `healthy` 在本次运行中保持 false，历史查询明确失败；启动时只修复当前日志未换行的尾部，已提交的损坏记录会阻止启动。轮换、保留上限及单写入者限制见 [开发说明](development.md#任务历史与重启phase-4)。这些新增命令和健康字段不改变 WebSocket 协议版本。

mock 和 MCP 测试服务只提供模拟数据，不能替代真实客户端、区域、截图和建造验收。写入本身不是跨多条 RPC 的原子事务；详见 [Phase 3 限制](PHASE3_REPORT.md)。
