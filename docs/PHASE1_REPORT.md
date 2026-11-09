# Phase 1：Linux 无游戏开发记录

日期：2026-11-09。环境：Ubuntu Linux x86_64，Node.js 24.19.0，OpenJDK 21.0.12.1，Codex CLI 0.167.0，Gradle 9.8.2。

## 结论

已实现并验证不依赖本地 Minecraft 客户端的聊天链路，包括真实 Codex 多轮聊天、Java ↔ Node WebSocket 通信和完整 Fabric Mod 编译打包。**尚未进行游戏内或 Windows 实机验收，因此 Phase 1 的最终游戏聊天验收仍待完成。** 没有实现或模拟宣称世界观察、截图、建造和建筑审批已通过。

## 已实现

- npm workspaces：`packages/shared` 和 `packages/gateway`，严格 TypeScript 构建。
- 共享 v1 JSON envelope、客户端消息校验、命令解析、任务状态类型。
- Gateway localhost HTTP/WebSocket 服务、bearer 认证、Origin/Host 检查、消息限制、心跳。
- 单客户端、单世界会话、串行任务队列；`status`、`queue`、`stop [task-id]`、`help`。
- 最近 1024 条命令回执去重、队列和历史上限、失败处理、断开与世界切换取消旧任务。
- 明确标注模拟回复的 mock 后端，以及真实 Codex app-server stdio 适配器。
- Codex 初始化、Thread 复用/恢复、Turn 结果通知、取消、超时、进程退出处理；失败 Turn 不自动重试。
- 从本机 CLI 生成并纳入仓库的协议类型；旧版与 v2 同名类型由生成器区分。
- Phase 1 聊天限制、独立工作目录、只读沙箱、不自动批准工具请求。
- 终端模拟客户端、配置示例、私有 token 文件、Companion 配置导出脚本。
- Companion Mod 游戏无关的配置、JSON 协议、JDK WebSocket 客户端，最多连续尝试 5 次连接。
- Mod 进入/退出世界生命周期、原有聊天拦截与本地 HUD 转发；消息回到 client thread 后再次检查会话代次，丢弃旧世界回调。

## 实际检查

| 检查 | 结果 | 证明范围 |
|---|---|---|
| `npm test` | 15 项通过 | 协议、认证、去重、队列、取消、会话、Codex 适配器故障与通知时序 |
| `npm run smoke` | 两轮往返通过 | 真实 Node WebSocket 通道 + mock 后端 |
| `npm run smoke -- --codex` | 两轮真实回复通过 | 真实 app-server 初始化、Thread、Turn、回复回传；没有 Minecraft 工具调用 |
| `npm run test:java` | 6 项 JUnit 通过，`JAVA_GATEWAY_SMOKE_OK` | 游戏无关 Java 类 + 真实 Java ↔ Node 认证通信与中文消息 |
| `./gradlew test build --no-daemon` | 构建通过，7 项 JUnit 通过 | 完整 Mod 源码、真实 Fabric 聊天事件 API、remap JAR |
| `npm run companion:config` | 导出成功，字段匹配、POSIX `0600` | Gateway/Mod 配置格式与凭证文件权限 |

Codex 适配器自动测试使用独立 JSON-RPC 子进程 fixture，覆盖通知早于响应、Turn 创建期间取消、异常退出、非法 stdout、RPC 超时和拒绝审批。这些故障测试不等同于真实 Codex 的所有异常行为；真实服务另外通过两轮聊天烟测验证。

Java 的 6 项单测也是完整 Gradle 测试的子集，不能相加宣称 13 个不同测试。Gradle 第 7 项为 `FabricChatEventContractTest`。

构建产物：`phase0/companion-mod/build/libs/minecraft-codex-companion-0.1.0.jar`。构建目录、依赖、运行配置和 token 均被 Git 忽略。

## 本机环境处理

安装了 Ubuntu OpenJDK 21 headless JDK。Gradle 默认分发地址跳转至 GitHub 后返回 504；随后通过 GitHub 官方 release asset API 下载同一个 9.8.2 ZIP，核对项目固定的 SHA-256：

```text
21bd5da2de49b642904077f38c0efdc7778e92b3ed0889392dca61b97e389607
```

填充本机 Wrapper 缓存后，仓库自带 `./gradlew test build --no-daemon` 成功。没有更换项目依赖版本，没有关闭校验。此网络处理只影响本机缓存，其他机器仍使用正常 Wrapper 下载路径。

## 尚需环境的工作

- Minecraft 真实聊天框输入、HUD 显示、游戏内连接和切换服务器烟测。
- Windows 上进程启动、路径、凭证文件 ACL 和 Mod 加载检查。
- Phase 2 的真实玩家位置、朝向、区域读取与截图。
- Phase 3 的建筑计划、可执行审批边界、方块写入和建造后验证。

当前 `worldSessionId` 仅用于隔离客户端会话，不是可信世界身份。后续不得直接把它用于写权限，也不得把聊天阶段的只读设置移除后就视为完成建造安全机制。`approve/reject` 当前只返回明确的未实现错误。
