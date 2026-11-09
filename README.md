# Minecraft Codex Builder

Windows 本地运行的 Minecraft Java Edition AI 建造助手实验项目。

当前完成 **Phase 0：依赖验证**，尚未进入完整功能开发。

## 当前验证结果

- Minecraft 1.21.11 + Fabric Loader 0.19.5。
- MCPFabric 0.9.1 Bridge 与 MCP Server。
- Codex CLI / app-server 0.167.0。
- Fabric 客户端聊天消息拦截。
- Java Companion Mod 与 Node.js Gateway WebSocket 通信。
- Codex app-server 通过 MCPFabric 读取、写入并恢复测试世界方块。

详细依据和测试计划见 [`PHASE0_REPORT.md`](PHASE0_REPORT.md)。

## 目录

- `MVP_DESIGN.md`：MVP 技术设计和阶段计划。
- `PHASE0_REPORT.md`：Phase 0 验证报告。
- `phase0/companion-mod`：最小 Fabric Companion Mod。
- `phase0/gateway-probe`：Java ↔ Node.js WebSocket 探针。
- `phase0/app-server-probe.mjs`：Codex app-server 握手探针。
- `phase0/app-server-mcp-probe.mjs`：Codex app-server MCP 工具探针。
- `phase0/evidence`：不含 secret 的验证证据。

## 构建 Companion Mod

需要 Java 21 和可访问 Fabric/Minecraft Maven 仓库的网络环境。

```powershell
cd phase0/companion-mod
./gradlew.bat test build --no-daemon
```

## 安全说明

- 所有本地服务仅监听 `127.0.0.1`。
- 不要提交 MCPFabric Bridge token、游戏配置、世界或日志。
- 当前代码仅用于依赖和接口验证，不应视为完整的安全建造代理。

## License

[MIT](LICENSE)
