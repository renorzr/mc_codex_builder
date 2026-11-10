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

`@codex <文本>` 创建任务。`!codex status/queue/help` 为控制命令，`!codex stop [task-id]` 停止运行中、待审批或指定排队任务。只有显式开启建造模式时，`!codex approve <task-id>` 才能确认当前会话里等待审批的计划；`reject` 取消计划。聊天和只读模式仍拒绝这些审批命令。等待审批时 `status` 会重新显示完整确认摘要。

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

所有任务串行执行。取消运行中任务时必须等待后端实际结束；Codex 优先发送 `turn/interrupt`，超时则关闭子进程，然后才可启动后续任务。失败任务不会自动重试。队列/历史默认最多保留 100 项，新任务优先淘汰已结束历史；没有可淘汰项时拒绝提交。

`worldSessionId` 是客户端每次进入世界生成的随机 nonce，**不是权威 Minecraft 世界身份**，不能用于未来写权限校验。新会话、`goodbye`、连接断开会取消全部旧任务，并等待执行结束后重置 Thread；旧事件不会推送到新会话。任务和回执只保存在内存，Gateway 重启后不恢复。

## 幂等与故障

Gateway 保留最近 1024 条会话内命令回执。相同 `worldSessionId + messageId` 且内容完全相同的消息复用原回执，不创建新任务；同 ID 不同内容报错。仍有任务记录时重发当前状态，记录已被清除时返回 `RESULT_EXPIRED`。这不是跨重启、无限期的执行去重保证。

Java 客户端断线后只重连和重新注册，不重发聊天指令。提交结果未知时提示查询状态。世界断开后任务会取消，历史也会清除，不能依赖 `status` 恢复已经丢失的结果。Gateway/Codex 进程崩溃后同样不自动重放原任务。

当前有 mock 后端和真实 Codex 后端。真实后端默认聊天，可显式启用只读观察或小型建筑。`writesEnabled=true` 只表示当前模式支持审批后的写入，不能当作单个任务已经获准。客户端不提供位置、建筑计划或写参数；这些由 Gateway 从本轮模型输出和 MCPFabric 读取结果校验。服务端新增模式和审批推送不改变客户端 envelope；老 Mod 仍可显示文字摘要，但欢迎消息不一定识别新模式。

每份建筑审批绑定任务、客户端会话、当前 `sp:` 世界 ID、维度、目标区域完整状态与计划指纹。审批仅内存持有、单次使用，默认 120 秒内确认；拒绝、过期、退出、切换、重启或执行失败均不能复用。计划 JSON 文件仅供查看，修改文件不改变内存中的执行内容。执行只使用已校验计划的最终赋值；重叠操作不会引入未展示的中间写入。

mock 和 MCP 测试服务只提供模拟数据，不能替代真实客户端、区域、截图和建造验收。写入本身不是跨多条 RPC 的原子事务；详见 [Phase 3 限制](PHASE3_REPORT.md)。
