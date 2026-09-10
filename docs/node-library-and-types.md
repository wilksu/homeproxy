# 节点库、原生订阅和类型覆盖（sing-box 1.14.0）

> 当前安装策略更新：采用全新配置安装；已移除新增的 1.14 迁移备份和旧订阅 ID 自动映射，主包与语言包分离。下文迁移/打包记录属于历史阶段，当前行为以 [开发与安装说明](development-and-installation.md) 为准。

节点设置新增 Tailscale、Selector 和 URLTest 类型。Tailscale 按 Endpoint 写入，支持 1.14.0 文档的认证、控制服务器、主机名、路由接受／通告、退出节点、系统接口、端口、SSH 开关及细分权限、Taildrop 目录。状态按节点持久保存；默认 Taildrop 子目录位于该状态目录。核心没有 with_tailscale 时不展示类型，验证器也会检查构建能力。不包含 1.15.0 的 on_demand。

原生 JSON 订阅提取支持的代理 outbounds，转换为现有 UCI 表单字段；具有本机管理能力的 Tailscale endpoint 禁止导入。不提供“原文 JSON 透传”后备路径。规则集、DNS 策略和路由规则不导入。Selector/URLTest 成员、默认选择及 detour 引用转为稳定节点 ID，并检查缺失和环。源对象还通过当前核心 check。不能映射的字段会拒绝该订阅更新并保留原节点，不能把这一版描述为所有 1.14 字段均已完成覆盖。

当前导入类型包括：Direct、AnyTLS、HTTP、Hysteria/2、Shadowsocks、ShadowTLS、SOCKS、SSH、Trojan、TUIC、VLESS、VMess、Selector、URLTest。现有手动 WireGuard 支持仍在，原生 WireGuard Endpoint 导入（包括多 Peer）尚未实现，需要完整建模。出站内的独立 domain_resolver 引用因为依赖未导入的 DNS 对象，会明确拒绝；需要后续设计本地解析器映射。部分 TLS 字段、非 Host 传输头、亚秒时间等超出现有表单模型的字段也会明确报错。以上为字段覆盖缺口，不是 sing-box 不支持。

节点身份：原生对象使用 source ID + tag；显示名不再作为全局 ID。源 ID 保存在 subscription_source 元数据中，单条订阅 URL 替换会保持原 source ID；同时批量替换多个 URL 不猜测对应关系。不迁移旧标签 ID；使用全新配置重新订阅。手动分享链接导入使用新 UCI ID；同源分享链接同名时按内容区分。订阅更新不再先停止服务，有变化的节点订阅更新在完成后重启核心。

自定义路由可直接从节点库选择出站／组，加载所需成员和 detour 依赖；旧路由节点兼容生成代码仍保留，但编辑标签已移除。节点来源与地址帮助区分同名项。

## 等待决定的其他类型

| 类型 | 当前缺口与用途 |
| --- | --- |
| Naive | 未提供节点表单；NaiveProxy 服务端出站，需相应核心构建能力。 |
| Snell | 未提供节点表单；连接 Snell 服务端。 |
| Tor | 未提供节点表单；连接 Tor 网络，运行依赖和资源开销需另行评估。 |
| Bridge | 未提供节点表单；1.14 的 L3 直出能力，需和 TUN / pre-match / 接口权限共同设计，非普通代理节点。 |
| OpenConnect Endpoint | 未提供表单和系统集成；企业 VPN 等场景，涉及认证流程。 |
| OpenVPN Client Endpoint | 未提供表单和系统集成；OpenVPN 客户端。 |
| OpenVPN Server Endpoint | 未提供表单和系统集成；服务端能力，不属于通常的节点订阅。 |

旧 DNS outbound、旧 WireGuard outbound 等已移除类型不作为新增支持目标。完整原生配置模式已移除；Tailscale 仅允许本地手动创建及客户端、自定义路由生成路径；订阅来源的存量 Tailscale 记录也会拒绝生成。

## 验证与限制

现有核心版本与 pinned source 文档交叉核对；生成器测试覆盖 Tailscale Endpoint、直接选择库节点、嵌套组依赖及旧模式。隔离数据验证来源隔离、引用检查及远端 Tailscale 拒绝；浏览器确认 Tailscale 类型与字段。未注册设备、未登录 Tailnet，也未验证真实 Tailscale 数据面或启用 SSH／路由通告。当前开发容器使用自定义路由，生成器按所选出站和规则加载依赖节点，未引用的节点和组仍在节点库中。
