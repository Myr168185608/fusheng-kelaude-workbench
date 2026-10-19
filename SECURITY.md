# 安全模型

> [!CAUTION]
> **工作台的登录口令，等同于这台服务器上服务账号的 Shell。**
> 登录后的人可以与 Claude 对话并让它执行命令、打开网页终端、读写文件。请像保护 SSH 私钥一样保护这个口令，并像对待一个远程 Shell 一样对待这个服务。

- [威胁模型](#威胁模型)
- [默认防护](#默认防护)
- [不在防护范围内的事](#不在防护范围内的事)
- [部署检查清单](#部署检查清单)
- [Root 运维](#root-运维)
- [报告安全问题](#报告安全问题)

---

## 威胁模型

| 角色 | 信任程度 | 工作台怎么对待 |
| --- | --- | --- |
| **持有口令的你** | 完全信任 | 登录后拥有服务账号的全部能力。工作台是单账号、单用户设计，没有角色与权限分级。 |
| **Claude（模型）** | 有限信任 | 它会犯错，也可能被**提示注入**误导：它读到的网页、日志、仓库文件里可能藏着试图操纵它的指令。所以有「逐次确认」模式、最小权限的服务账号，以及只授权具体命令的 sudoers。 |
| **互联网上的其他人** | 不信任 | 除了静态页面、健康检查与登录本身，所有接口都需要登录；所有写操作还要通过来源校验与 CSRF 令牌。 |
| **同一台服务器上的其他账号** | 不信任 | 进程以 `umask 077` 运行，数据目录只有服务账号自己可读写。 |

---

## 默认防护

| 层面 | 措施 |
| --- | --- |
| 网络 | 默认只监听 `127.0.0.1:17880`。公网访问应当经过 Nginx 的 HTTPS，或者干脆只用 SSH 隧道。 |
| 口令 | 至少 12 个字符；磁盘上只保存 scrypt 哈希（`N=32768, r=8, p=1`），校验时使用常量时间比较。 |
| 登录限流 | 同一来源 IP 在 15 分钟内最多尝试 8 次；同时进行的口令校验不超过 2 个，避免被用来耗尽 CPU。 |
| 登录会话 | 32 字节随机令牌，服务器只保存它的 SHA-256 摘要。Cookie 带有 `HttpOnly; SameSite=Strict`，HTTPS 下另加 `Secure`。12 小时后过期，最多同时保留 20 个登录。修改口令会让所有浏览器退出登录。 |
| 跨站请求 | 所有写操作都必须带有与 `WORKBENCH_ORIGIN` 完全一致的 `Origin` 头、`application/json` 请求体，以及与登录会话绑定的 `X-CSRF-Token`。 |
| 浏览器 | 严格的内容安全策略：`script-src 'self'`，不加载任何外部资源，禁止被嵌入（`frame-ancestors 'none'`、`X-Frame-Options: DENY`）。另有 `Referrer-Policy: no-referrer` 与 `nosniff`。Claude 的 Markdown 回复转换成 HTML 后，先经过 DOMPurify 净化再插入页面。 |
| 请求体 | JSON 上限：普通接口 96 KB，文件写入 3 MB，上传 12 MB。 |
| 反向代理 | 只信任本机回环地址上的代理提供的 `X-Forwarded-For`，外部伪造的来源 IP 无法绕过登录限流。 |
| 网页文件接口 | 限制在当前会话的工作区内：`O_NOFOLLOW` 打开、真实路径校验、锚定已验证目录的 inode，拒绝含有符号链接或外部引用的 Git 元数据。 |
| 网页展示 | 推送到网页的工具输入会先脱敏：`sk-ant-` 密钥、Bearer 令牌，以及 `password`、`api_key`、`access_token` 等字段都显示为 `[REDACTED]`。 |
| CLI 环境 | 启动 Claude Code 前移除与凭据、服务商、代码注入相关的环境变量（完整列表见 [工作原理](docs/ARCHITECTURE.md#8-环境隔离)），保证它只使用服务账号以官方方式登录的那一个账号。 |
| 进程 | 示例 systemd 单元以专用普通账号运行，并启用 `NoNewPrivileges`、`RestrictSUIDSGID`、`ProtectSystem=full`、`PrivateTmp` 等加固选项。默认情况下 Claude 和网页终端**无法使用 sudo**。 |

---

## 不在防护范围内的事

下面这些是设计上的边界，部署前请确认你能接受：

- **工作区边界不是沙箱。** 它只约束网页上的文件面板。Claude Code 和网页终端以服务账号身份运行，能访问这个账号能访问的一切。真正的权限边界是服务账号本身、systemd 加固与 sudoers。
- **「自动同意」模式下，Claude 执行命令前不会询问你。** 在重要的服务器上，请使用「逐次确认」。
- **审批卡片只是展示，最终判断在你。** 批准之前请读完完整命令，特别是 Claude 读过外部内容之后。
- **没有内置的双因素认证。** 口令一旦泄露，攻击者就拿到了服务账号的 Shell。需要更强的保护时，请把工作台放在 SSH 隧道、VPN，或带额外认证的反向代理之后（例如客户端证书或零信任网关）。
- **不限制网络访问。** Claude 和终端能访问服务器能访问的任何网络地址。
- **会话记录未加密。** 对话内容和命令输出以 JSON 形式保存在数据目录里，可能包含你在服务器上看到的敏感信息。请保护好数据目录及其备份。
- **数据会发送给 Anthropic。** 这是 Claude Code 的正常工作方式：你的消息、Claude 读取的文件内容和命令输出，都会作为上下文发送给 Anthropic 处理。不要让它读取你不愿意发送出去的数据。

---

## 部署检查清单

- [ ] 服务以**专用普通账号**运行，不是 root，也不是你的个人账号
- [ ] `ss -ltnp | grep 17880` 只显示 `127.0.0.1`，防火墙没有放行 17880
- [ ] 公网访问只走 HTTPS，或者只用 SSH 隧道
- [ ] `WORKBENCH_ORIGIN` 与浏览器地址栏完全一致
- [ ] 口令足够长且独一无二，推荐 16 个字符以上的随机口令或口令短语
- [ ] 在重要的服务器上默认使用「逐次确认」
- [ ] 定期备份数据目录，重要的服务器还有快照，能随时回滚
- [ ] 及时升级工作台、Claude Code 与操作系统

---

## Root 运维

默认部署下，systemd 的 `NoNewPrivileges=yes` 会让 sudo 完全失效，这是最安全的状态。如果你确实需要 Claude 代为执行特权操作，例如检查并重载 Nginx 配置、续期证书，请**按需授权**，不要整体放开。

### 开启方式

步骤见 [部署指南 · 可选：Root 运维](docs/DEPLOYMENT.md#11-可选root-运维)，共有三层，各管一件事：

| 层 | 文件 | 作用 |
| --- | --- | --- |
| systemd drop-in | [`deploy/systemd/root-operations.conf`](deploy/systemd/root-operations.conf) | 放开与 sudo 冲突的加固选项，并设置 `WORKBENCH_ROOT_OPERATIONS=1` |
| sudoers | [`deploy/sudoers/cloud-ops-workbench.example`](deploy/sudoers/cloud-ops-workbench.example) | 决定服务账号**实际**能以 root 身份运行哪些命令。示例只授权了 Nginx 检查与重载、证书续期 |
| 日志组 | `usermod -aG adm,systemd-journal workbench` | 读取系统日志不需要 sudo |

`WORKBENCH_ROOT_OPERATIONS=1` 只是通过 `--append-system-prompt` 告诉 Claude：服务器所有者允许它在本机 sudo 策略范围内执行特权命令，并要求它控制改动范围、重启服务前先备份。**这个开关本身不授予任何权限。**

### 写 sudoers 时的原则

> [!WARNING]
> **永远不要写 `workbench ALL=(ALL) NOPASSWD: ALL`。** 那等于把服务器的 root 交给了网页口令和一个会犯错的模型。

很多看起来无害的命令，实际上等同于完整的 root 权限，因为它们能写任意文件或启动一个 Shell：

| 类别 | 例子 |
| --- | --- |
| 写文件 | `tee`、`cp`、`mv`、`dd`、`install`、`ln`、`chmod`、`chown`、`tar`、`rsync` |
| 编辑器与分页器 | `vim`、`nano`、`less`、`more`、`man`、`systemctl edit` |
| 包管理器与解释器 | `apt`、`dpkg`、`pip`、`npm`、`python3`、`bash`、`env` |
| 可执行任意命令的工具 | `find`（`-exec`）、`awk`、`xargs`、`git`、`docker`、`crontab` |
| 带通配符的规则 | `systemctl restart *`、`/usr/bin/cat /var/log/*` |

建议：

1. 只写**完整路径加完整参数**的命令，例如 `/usr/bin/systemctl reload nginx`；
2. 每次新增规则后都执行 `sudo visudo -cf /etc/sudoers.d/cloud-ops-workbench` 校验；
3. 开启 Root 运维后，日常使用「逐次确认」模式，每条特权命令都由你亲自批准；
4. 不再需要时立即撤销。

### 撤销

```bash
sudo rm -f /etc/sudoers.d/cloud-ops-workbench
sudo rm -f /etc/systemd/system/cloud-ops-workbench.service.d/root-operations.conf
sudo gpasswd -d workbench adm; sudo gpasswd -d workbench systemd-journal
sudo systemctl daemon-reload && sudo systemctl restart cloud-ops-workbench
```

---

## 报告安全问题

如果你发现了工作台本身的安全问题，请**不要**公开提交 Issue，而是通过仓库的 **Security → Report a vulnerability** 私下报告：

**<https://github.com/qiuxinyuan321/cloud-ops-workbench/security/advisories/new>**

报告时请尽量提供：受影响的版本或提交、复现步骤、影响范围。这是一个业余维护的个人项目，没有响应时限上的承诺，但每一份报告都会认真对待。只有 `main` 分支的最新版本会得到修复。

Claude Code CLI 本身的安全问题，请直接报告给 Anthropic。
