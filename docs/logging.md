# 开发日志

`pn run dev` 使用便于阅读的本地日志，显示时间、级别和消息。异常保留完整堆栈。普通启动以及生产环境使用结构化 JSON，`LOG_LEVEL` 可调整日志级别。

源码和 Node 输出使用 UTF-8。在 Windows PowerShell 中，如果终端或管道按代码页 936 解码 UTF-8 输出，中文会显示为乱码。先检查当前会话：

```powershell
chcp
[Console]::OutputEncoding
$OutputEncoding
```

如果编码不一致，可在当前 PowerShell 会话执行：

```powershell
chcp 65001
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
pn run dev
```

这些设置只影响当前控制台会话及使用该控制台的子进程，不修改系统区域设置或 PowerShell 配置文件。关闭终端后会话设置结束。已有程序如果共享同一个控制台，也可能在会话期间受到代码页变化影响。
