# Minecraft Codex 轻量启动器

## 使用

双击仓库根目录的 `Start-Minecraft-Codex.cmd`：

1. 如果 Build Gateway 尚未运行，则在独立 Gateway 窗口启动并等待就绪。
2. 检查游戏实例 token、官方启动器 profile 和必要 Mod。
3. 打开 Minecraft 官方启动器。
4. 在官方启动器选择 `Minecraft Codex 1.21.11`，点击 Play。

Gateway 窗口会实时输出 Codex 的回合开始/结束、shell 命令、文件修改、MCP 工具调用、退出码、耗时和可见消息摘要。运行启动脚本时不带参数可打开菜单，其中 `[6]` 可在另一个窗口实时跟踪执行日志。

官方启动器没有公开的“按指定 profile 直接 Play”命令行入口。启动器不会读取、复制或复用 Minecraft 登录令牌，因此最后点击 Play 是刻意保留的人工步骤。

停止自动启动的 Gateway：

```text
Stop-Minecraft-Codex-Gateway.cmd
```

也可以直接运行 PowerShell 脚本中的状态/菜单模式：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\launcher\Minecraft-Codex-Launcher.ps1
```

## 文件与日志

- Gateway PID：`.local/launcher/gateway.pid`
- Gateway 日志：`.local/launcher/gateway.log`
- 游戏实例：`%APPDATA%/.minecraft-codex-1.21.11`
- 官方启动器 profile：`Minecraft Codex 1.21.11`

启动器不复用或输出 Gateway token。停止脚本只接受本启动器进程，或可确认来自游戏实例 `Start-Gateway-Build.cmd` 的旧 Build 进程链；其他占用端口的情况会拒绝停止，避免误杀。