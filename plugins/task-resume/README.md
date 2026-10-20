# 任务断点续跑

这是随仓库提供、默认关闭的独立可选插件。启用后，插件在自己的目录保存任务状态、官方 Claude 会话 ID、轮次 ID 和最后工具的名称/状态。对话正文、工具输入输出与认证凭据不复制到检查点。

在插件面板查看中断任务，任务名称跟随原会话的最新标题，点击“从检查点继续”。恢复通过宿主在原会话、原工作区调用官方 `--resume`，先要求 Claude 核对文件和已经完成的操作，继续未完成的部分。没有官方会话 ID 或原会话已改变时明确拒绝，不能退回到重新发送原任务。

“自动恢复”默认关闭，必须在面板保存设置后才开启。自动恢复只处理可恢复的进程失败或服务中断，每项任务最多 1–5 次（默认 2 次），从 30 秒开始指数延长等待，最长 5 分钟。新的一轮用户任务重置重试计数。其他任务运行时等待；额度拒绝留给账号插件或用户处理；手动停止、取消恢复、等待审批/回答不会自动继续。停止服务时保留中断标记，关闭插件或安全模式会停止恢复队列。

检查点不是进程内存快照，也不是文件上传的断点续传。它不能还原已退出的系统进程，不能保证外部操作恰好执行一次。恢复时仍需核对结果不确定的发送、部署、支付等操作；原有工具权限和用户审批继续由宿主维护。

## 后端契约

`activate` 是 `createTaskResume` 的别名，工厂接收插件私有 `dataDir`、`listSessions`、`getSession`、`startTurn`、`isBusy`、`isActive`，可注入 `now`。工厂仅在插件显式启用时创建。

- `beforeRun({session, request, run, kind})`：图形任务开始前持久化检查点，`run.messageId` 标识轮次；`kind=terminal` 跳过。插件发起的 `request.source=task-resume` 保留重试计数。
- `onEvent({session,event,run})`：接收官方 session、工具状态、审批和限额事件。
- `onExit({session,result,run})`：宿主已完成状态归并后调用；`result.shutdown` 保留中断，`result.preflightFailed` 撤回尚未启动的检查点。
- `onStop({session,reason,run})`：`user` 为手动停止，`shutdown/restart` 为服务中断。
- `close()`：清理队列和等待持久化，不修改宿主会话或停止其他任务。

服务端方法为 `list`、`settings.get`、`settings.update`、`resume({sessionId})`、`cancel({sessionId})`。前端只能通过宿主 `wb.backend.call()` 访问本插件的方法。

检查点位置：宿主传入目录下的 `checkpoints.json`，格式版本 1；原子写入、文件权限 `0600`。损坏或不安全的文件会保留原样并阻止插件启用。

验证：`node --test test/task-resume.test.mjs`。测试覆盖服务重启、手动停止、审批、官方会话缺失、有限自动重试、插件停用、旧轮次事件、认证预检失败、私密内容排除及损坏数据保护。
