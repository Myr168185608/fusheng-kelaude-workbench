# 部署指南

本文以 **Debian 12 / Ubuntu 22.04 及以上**为例，把工作台部署成一个长期运行的 systemd 服务，并通过 Nginx 提供 HTTPS 访问。其他发行版思路相同，命令按需调整。

> [!IMPORTANT]
> 部署前请先阅读 [免责声明](../DISCLAIMER.md) 与 [安全模型](../SECURITY.md)。
> 工作台把服务器的终端与 Claude Code 的执行能力放到了网页上，**登录口令等同于这台服务器的 Shell 权限**。

**目录**

1. [准备](#1-准备)
2. [创建服务账号](#2-创建服务账号)
3. [安装官方 Claude Code 并登录](#3-安装官方-claude-code-并登录)
4. [安装工作台](#4-安装工作台)
5. [写配置](#5-写配置)
6. [设置登录口令](#6-设置登录口令)
7. [注册 systemd 服务](#7-注册-systemd-服务)
8. [配置 HTTPS](#8-配置-https)
9. [不想暴露到公网：SSH 隧道](#9-不想暴露到公网ssh-隧道)
10. [日常维护](#10-日常维护)
11. [可选：Root 运维](#11-可选root-运维)
12. [排错](#12-排错)
13. [卸载](#13-卸载)

---

## 1. 准备

| 项目 | 要求 |
| --- | --- |
| 服务器 | 你拥有管理权限的 Linux 服务器，建议 2 核 / 2 GB 内存以上 |
| 所在地区 | **你本人与服务器都位于 [Anthropic 支持的国家和地区](https://www.anthropic.com/supported-countries)** |
| 账号 | 你自己的 Claude 账号，能在服务器上正常登录官方 Claude Code |
| 软件 | Node.js ≥ 20、npm、git、python3（网页终端需要） |
| 域名（可选） | 通过 HTTPS 访问时需要；只用 SSH 隧道则不需要 |

```bash
sudo apt update
sudo apt install -y git python3 curl
node --version   # 需要 v20 或更高；没有的话请按 Node.js 官方文档安装
```

## 2. 创建服务账号

工作台和 Claude Code 都应该运行在一个**专用的普通账号**下，而不是 root，也不是你自己的登录账号：

```bash
sudo useradd --system --create-home --home-dir /var/lib/cloud-ops-workbench --shell /bin/bash workbench
```

这个账号的家目录 `/var/lib/cloud-ops-workbench` 会存放 Claude Code 的登录状态（`~/.claude`）和工作台数据。

## 3. 安装官方 Claude Code 并登录

以服务账号身份，按 [Claude Code 官方文档](https://code.claude.com/docs/en/setup) 安装并登录：

```bash
sudo -iu workbench
curl -fsSL https://claude.ai/install.sh | bash   # 官方安装脚本，安装到 ~/.local/bin/claude
~/.local/bin/claude                              # 首次运行按提示登录；服务器上没有浏览器时，复制登录链接到本地打开
~/.local/bin/claude auth status                  # 看到 "loggedIn": true 即可
exit
```

> [!NOTE]
> 只登录**你自己的**账号。本项目是单账号版本，不支持、也不应被用于共享账号或在多个账号之间切换。

## 4. 安装工作台

程序目录归你的管理员账号所有，服务账号只读，这样即使会话里发生意外，也无法改写工作台本身：

```bash
sudo mkdir -p /opt/cloud-ops-workbench
sudo chown "$USER": /opt/cloud-ops-workbench
git clone https://github.com/qiuxinyuan321/cloud-ops-workbench.git /opt/cloud-ops-workbench
cd /opt/cloud-ops-workbench
npm ci
npm run build    # 打包 Monaco 编辑器；不打包时编辑器会退化为纯文本框，其余功能不受影响
npm test         # 可选：运行测试
```

## 5. 写配置

```bash
sudo mkdir -p /etc/cloud-ops-workbench
sudo cp /opt/cloud-ops-workbench/.env.example /etc/cloud-ops-workbench/workbench.env
sudo nano /etc/cloud-ops-workbench/workbench.env
```

推荐的取值（`workbench.example.com` 换成你的域名）：

```ini
WORKBENCH_ORIGIN=https://workbench.example.com
WORKBENCH_HOST=127.0.0.1
PORT=17880
WORKBENCH_DATA=/var/lib/cloud-ops-workbench/data
CLAUDE_BINARY=/var/lib/cloud-ops-workbench/.local/bin/claude
```

`WORKBENCH_ORIGIN` 必须与浏览器地址栏**完全一致**（协议、域名、端口）。所有写操作都会校验这个来源，不一致时会提示「请求来源不匹配」。完整的变量说明见 [README · 配置](../README.md#配置)。

## 6. 设置登录口令

```bash
sudo -u workbench env WORKBENCH_DATA=/var/lib/cloud-ops-workbench/data \
  node /opt/cloud-ops-workbench/scripts/set-password.mjs
```

输入时不回显，需要输入两次，至少 12 个字符。磁盘上只保存 scrypt 哈希，文件权限为 `0600`。以后修改口令也用这条命令，改完重启服务即可，所有浏览器都需要重新登录。

## 7. 注册 systemd 服务

```bash
command -v node   # 确认路径；如果不是 /usr/bin/node，请修改服务单元里的 ExecStart
sudo cp /opt/cloud-ops-workbench/deploy/systemd/cloud-ops-workbench.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cloud-ops-workbench

systemctl status cloud-ops-workbench
curl -fsS http://127.0.0.1:17880/healthz   # 返回 {"ok":true}
```

服务单元默认启用了一组加固选项（`NoNewPrivileges`、`ProtectSystem=full`、`PrivateTmp` 等）：Claude Code 和网页终端只有服务账号自身的权限，无法使用 sudo。

## 8. 配置 HTTPS

1. 把域名的 A / AAAA 记录指向服务器，并在防火墙放行 80 与 443 端口。**不要**放行 17880：工作台只监听本机。
2. 安装 Nginx 与 certbot，并签发证书：

   ```bash
   sudo apt install -y nginx certbot python3-certbot-nginx
   sudo certbot certonly --nginx -d workbench.example.com
   ```

3. 启用站点配置：

   ```bash
   sudo cp /opt/cloud-ops-workbench/deploy/nginx/cloud-ops-workbench.conf /etc/nginx/sites-available/
   sudo sed -i 's/workbench.example.com/你的域名/g' /etc/nginx/sites-available/cloud-ops-workbench.conf
   sudo ln -s /etc/nginx/sites-available/cloud-ops-workbench.conf /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   ```

4. 打开 `https://你的域名`，用第 6 步设置的口令登录。

示例配置里有两处是工作台特有的，自己写配置时请保留：

- `proxy_buffering off` 与 `proxy_read_timeout 1h`：对话、终端和额度都通过 SSE 长连接实时推送，开启缓冲会导致回复卡住后一次性出现；
- `proxy_set_header X-Forwarded-For $remote_addr`：工作台只信任本机回环地址上的代理，并据此识别来源 IP，登录限流按来源 IP 计算。

## 9. 不想暴露到公网：SSH 隧道

只有你自己使用时，最安全的方式是完全不开放 Web 端口：

```bash
# 在你自己的电脑上执行
ssh -N -L 17880:127.0.0.1:17880 you@your-server
```

然后在本地浏览器打开 `http://127.0.0.1:17880`。这种情况下保持 `WORKBENCH_ORIGIN=http://127.0.0.1:17880` 即可，不需要 Nginx 和证书。

## 10. 日常维护

| 操作 | 命令 |
| --- | --- |
| 查看日志 | `journalctl -u cloud-ops-workbench -f` |
| 升级工作台 | `cd /opt/cloud-ops-workbench && git pull && npm ci && npm run build && sudo systemctl restart cloud-ops-workbench` |
| 升级 Claude Code | `sudo -iu workbench /var/lib/cloud-ops-workbench/.local/bin/claude update` |
| 修改口令 | 重新执行第 6 步的命令，然后 `sudo systemctl restart cloud-ops-workbench` |
| 检查 Claude 登录 | `sudo -iu workbench /var/lib/cloud-ops-workbench/.local/bin/claude auth status` |

> [!WARNING]
> 重启服务会中断正在运行的任务。请在会话空闲时升级或重启。

**备份**：会话记录、口令哈希与工作区都在 `/var/lib/cloud-ops-workbench/data`，定期备份这个目录即可。Claude 的登录凭据（`~/.claude`）属于你的账号安全信息，不要复制到其他机器或分享给他人。

## 11. 可选：Root 运维

默认部署下，Claude 无法使用 sudo。如果你确实需要它代为执行特权操作（例如重载 Nginx、续期证书），请按下面的步骤**按需授权**，并先完整阅读 [SECURITY.md · Root 运维](../SECURITY.md#root-运维)：

```bash
# 1) 放开 systemd 中与 sudo 冲突的限制，并打开 Root 运维开关
sudo mkdir -p /etc/systemd/system/cloud-ops-workbench.service.d
sudo cp /opt/cloud-ops-workbench/deploy/systemd/root-operations.conf /etc/systemd/system/cloud-ops-workbench.service.d/

# 2) 只授权具体命令（先按需编辑示例，再用 visudo 校验）
sudo install -m 0440 /opt/cloud-ops-workbench/deploy/sudoers/cloud-ops-workbench.example /etc/sudoers.d/cloud-ops-workbench
sudo visudo -cf /etc/sudoers.d/cloud-ops-workbench

# 3) 读日志不需要 sudo，加入只读日志组即可
sudo usermod -aG adm,systemd-journal workbench

sudo systemctl daemon-reload && sudo systemctl restart cloud-ops-workbench
```

开启后，建议日常使用「逐次确认」模式，每条特权命令都由你亲自批准。

## 12. 排错

| 现象 | 原因与处理 |
| --- | --- |
| 服务启动失败，日志提示「未找到登录口令文件」 | 还没有设置口令，执行第 6 步。 |
| 页面提示「请求来源不匹配」或「请从工作台页面发起操作」 | `WORKBENCH_ORIGIN` 与地址栏不一致，例如用 `localhost` 打开但配置的是 `127.0.0.1`。 |
| 页面提示「工作台尚未登录 Claude 账号」 | 以服务账号执行 `claude auth status`；确认 `CLAUDE_BINARY` 指向的是服务账号安装的那个 `claude`。 |
| 回复不是逐字出现，而是卡住后一次性出现 | 反向代理开启了缓冲，检查 `proxy_buffering off`。 |
| 网页终端无法打开 | 服务器缺少 `python3`。 |
| 文件编辑器只是一个纯文本框 | 还没有执行 `npm run build`。 |
| 登录提示「尝试次数较多」 | 同一来源 IP 15 分钟内失败次数过多，稍后再试；若所有人都显示同一个 IP，检查 Nginx 的 `X-Forwarded-For` 设置。 |

## 13. 卸载

```bash
sudo systemctl disable --now cloud-ops-workbench
sudo rm -rf /etc/systemd/system/cloud-ops-workbench.service /etc/systemd/system/cloud-ops-workbench.service.d
sudo systemctl daemon-reload
sudo rm -f /etc/nginx/sites-enabled/cloud-ops-workbench.conf /etc/nginx/sites-available/cloud-ops-workbench.conf
sudo systemctl reload nginx
sudo rm -f /etc/sudoers.d/cloud-ops-workbench
sudo rm -rf /opt/cloud-ops-workbench /etc/cloud-ops-workbench
sudo userdel -r workbench   # 同时删除 /var/lib/cloud-ops-workbench：会话记录、工作区与 Claude 登录状态
```
