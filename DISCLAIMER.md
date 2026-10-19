# 免责声明

> [!IMPORTANT]
> 使用、部署、修改或分发本项目，即表示你已阅读、理解并同意本声明的全部内容。如果你不同意其中任何一条，请不要使用本项目。

- [1. 项目性质](#1-项目性质)
- [2. 遵守 Anthropic 的条款](#2-遵守-anthropic-的条款)
- [3. 仅限单账号、本人使用](#3-仅限单账号本人使用)
- [4. 地区限制与跨地区使用](#4-地区限制与跨地区使用)
- [5. 部署与运维风险](#5-部署与运维风险)
- [6. 数据与隐私](#6-数据与隐私)
- [7. 额度与费用显示](#7-额度与费用显示)
- [8. 商标](#8-商标)
- [9. 社区交流群](#9-社区交流群)
- [English summary](#english-summary)

---

## 1. 项目性质

- 云端运维工作台（Cloud Ops Workbench）是爱好者出于个人兴趣开发、供自己使用的开源项目，按 [MIT 许可证](LICENSE)「按现状」提供，**不附带任何明示或暗示的担保**，包括但不限于适销性、特定用途适用性与不侵权的担保。
- 本项目是**非官方**项目，与 Anthropic PBC **没有任何隶属、合作、授权或背书关系**。
- 本项目**不提供**任何 Claude 账号、订阅、额度、API 密钥或模型访问服务。它只是调用你自己在服务器上安装、并通过 Anthropic 官方流程登录的 Claude Code CLI。
- 作者不对技术支持、可用性或后续维护做任何承诺。

## 2. 遵守 Anthropic 的条款

通过本项目使用 Claude Code，与你在终端里直接运行 `claude` 一样，受你与 Anthropic 之间协议的约束。你有责任自行阅读并遵守：

- [消费者服务条款](https://www.anthropic.com/legal/consumer-terms)（Free、Pro、Max 用户）或 [商业服务条款](https://www.anthropic.com/legal/commercial-terms)（Team、Enterprise 与 API 用户）
- [使用政策](https://www.anthropic.com/legal/aup)
- [支持地区政策](https://www.anthropic.com/legal/supported-regions)
- [Claude Code 法律与合规说明](https://code.claude.com/docs/en/legal-and-compliance)

Anthropic 的条款与政策可能随时更新，一切以其官方最新版本为准。本仓库中的任何内容都不构成法律意见，也不代表 Anthropic 的立场。如果你的用法与这些条款冲突，请以条款为准，并停止相应的使用。

## 3. 仅限单账号、本人使用

本仓库是**单账号版本**，在设计上只服务于一个人、一个 Claude 账号：

- 只使用**你本人合法持有**的 Claude 账号，由**你本人**在**你自己的服务器**上使用；
- 登录必须通过 Claude Code 自带的官方流程完成。本项目不读取、不保存、不转发你的 Claude 登录凭据或会话令牌；
- **不得**多人共用一个账号或订阅，**不得**轮换多个账号来规避额度或限流，**不得**出租、转售或以任何形式中转对 Claude 的访问，**不得**把部署好的工作台作为服务提供给他人使用。

Anthropic 在 [Claude Code 法律与合规说明](https://code.claude.com/docs/en/legal-and-compliance) 中写明：Pro 与 Max 套餐公布的用量额度，以**普通的个人使用**为前提。

如果你需要让其他人使用 Claude 的能力，例如团队或产品场景，请改用 Anthropic 为此提供的方式（Team / Enterprise 套餐，或 Claude Console 的 API 密钥），并遵守相应的商业条款。本项目不为这类场景设计，也不提供支持。

## 4. 地区限制与跨地区使用

- Claude 只在 Anthropic [支持的国家和地区](https://www.anthropic.com/supported-countries) 提供服务。根据 Anthropic 的 [支持地区政策](https://www.anthropic.com/legal/supported-regions)，未列出的国家和地区均不受支持。以下使用都不被允许：**人身处不受支持的地区时使用**；注册地或总部位于不受支持地区的实体使用；由这些地区的个人或实体直接或间接多数持股或控制的实体使用。
- **中国大陆**等地区不在支持列表中。本项目**不面向**这些地区的用户，也**不应**在这些地区使用。
- 我们**不建议、也不支持**任何形式的跨地区使用，包括借助代理、VPN、境外服务器或他人账号来绕过地区限制。把 Claude Code 部署在海外的云服务器上，**并不会**改变你本人所在的地区，本项目也**不是**、不能被用作规避地区限制的工具。
- 因在不受支持的地区使用、跨地区使用或违反 Anthropic 条款而导致的**账号封禁、额度或订阅损失**，以及由此产生的任何其他后果，**均由使用者自行承担**，与本项目作者和贡献者无关。

## 5. 部署与运维风险

工作台把服务器的命令执行能力放到了网页上。部署和使用它，意味着你理解并接受以下风险：

- **安全风险**：口令泄露、配置错误（例如把端口直接暴露到公网、没有启用 HTTPS）、依赖漏洞或本项目自身的缺陷，都可能导致服务器被入侵。部署前请阅读 [SECURITY.md](SECURITY.md)。
- **AI 出错的风险**：Claude 可能误解你的意图，执行错误的或破坏性的操作，例如删除文件、改坏配置、重启关键服务、产生云资源费用。在「自动同意」模式下或开启 Root 运维后，这类风险更高。
- **提示注入的风险**：Claude 读到的网页、文件、日志或命令输出中可能藏有恶意指令，诱导它做出你不希望的操作。
- **可用性风险**：工作台、Claude Code 或 Anthropic 服务的中断、变更与限流，可能让正在进行的任务失败，或停在中间状态。

建议你先在测试服务器上试用；在重要的服务器上使用「逐次确认」模式，读完每一条待批准的命令再决定；做好备份与快照；只授予完成任务所需的最小权限。

**在适用法律允许的最大范围内，对于因使用或无法使用本项目而产生的任何直接、间接、附带、特殊或后果性损失，包括但不限于数据丢失、服务中断、安全事件、账号封禁、额度或费用损失、业务或利润损失，项目作者和贡献者均不承担任何责任。**

## 6. 数据与隐私

- 工作台本身没有遥测，不会向作者或任何第三方发送数据。
- Claude Code 会把你的消息，以及 Claude 读取的文件内容和命令输出，作为上下文发送给 Anthropic 处理。这部分数据受 Anthropic 的条款与 [隐私政策](https://www.anthropic.com/legal/privacy) 约束。
- 会话记录以明文 JSON 保存在你的服务器上，请保护好数据目录及其备份。
- 不要用本项目处理你无权处理的数据，例如他人的个人信息、负有保密义务的资料，或适用法规限制传输的数据。

## 7. 额度与费用显示

网页上的额度来自 Claude Code 的 `/usage` 输出，可能存在延迟或误差。「API 等价估算」只是按 API 价格换算出的参考值，不是你的账单。一切以 Anthropic 官方的显示与账单为准。

## 8. 商标

Claude、Claude Code 与 Anthropic 是 Anthropic PBC 的商标。本项目只以文字说明它运行的是 Claude Code，项目名称与标志中不包含 Anthropic 的任何名称或标志，也不暗示与 Anthropic 存在任何关联。文中提到的其他商标归各自的所有者所有。

## 9. 社区交流群

QQ 群 **820116443** 是爱好者自发组织的交流群，用来交流本项目的部署与使用心得：

- 它**不是** Anthropic 的官方渠道，加入交流群也不意味着本项目提供任何技术支持承诺；
- 本项目**不提供、不推荐、也不对接**任何第三方账号、额度或 API 中转与转售服务。群内任何人提供的产品、服务或信息都与本项目无关，请自行甄别，风险自负；
- 请在交流中遵守你所在地的法律法规，以及 Anthropic 的条款与政策。

本声明可能随项目更新而修改，以仓库中的最新版本为准。

---

## English summary

- **Unofficial hobby project.** Provided "as is" under the MIT License, without warranty of any kind. Not affiliated with, endorsed by, or sponsored by Anthropic PBC.
- **No Claude access is provided.** The project drives the official, unmodified Claude Code CLI that you install and sign in to yourself through Anthropic's own login flow. It never reads, stores, or relays your Claude credentials.
- **One account, personal use only.** No account sharing, account rotation, resale or intermediation of Claude access, and no offering the workbench as a service to others.
- **Supported regions only.** Use only where Anthropic supports Claude. Use while physically located in an unsupported region (for example, mainland China) is not allowed under Anthropic's Supported Regions Policy. Hosting Claude Code on an overseas server does not change where you are. Any account suspension or other loss caused by unsupported or cross-region use is solely your responsibility.
- **You run a remote shell.** A web-exposed server shell and an AI agent that can make destructive mistakes are real risks. You are responsible for your deployment, approvals, and backups. The authors are not liable for any damages.
- **Trademarks.** Claude, Claude Code, and Anthropic are trademarks of Anthropic PBC.
- **Community group.** The QQ group is an informal community chat, not an official channel. This project does not provide, endorse, or integrate with any third-party account, quota, or API resale service.
