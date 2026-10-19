// Enabled only by the operator's service configuration (the WORKBENCH_ROOT_OPERATIONS
// environment variable), never by anything in a request body. When enabled, the CLI is told
// it may use elevated privileges according to the host's own sudo policy.
export const ROOT_OPERATIONS_PROMPT = '服务器所有者已为这个私人工作台启用管理员运维能力。Claude Code 以服务账号身份运行；需要提升权限的命令按主机的 sudo 策略使用 sudo 执行。请把改动控制在当前任务范围内。重启工作台会中断当前会话，因此部署或重启应先备份，并把完整执行、健康检查和失败回退交给独立进程（例如 systemd 单元），不要依赖当前会话保持存活。';

export function rootOperationsArgs(env = process.env) {
  return env.WORKBENCH_ROOT_OPERATIONS === '1' ? ['--append-system-prompt', ROOT_OPERATIONS_PROMPT] : [];
}
