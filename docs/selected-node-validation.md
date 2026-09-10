# 当前节点运行验证（2026-09-09）

只在 HomeProxy 开发容器执行，无编译、无批量节点测试、无文件下载性能测试。用户导入的订阅与节点保留。

当前设置：

- 主节点：Fast-B1-2（Shadowsocks）。
- UDP 节点：same，跟随主节点。
- 路由模式：bypass_mainland_china，沿用绕过大陆模式。
- DNS：https://cloudflare-dns.com/dns-query，经 main-out。
- 国内 DNS：https://dns.alidns.com/dns-query，经 direct-out。
- 核心：sing-box 1.14.0，API v4，监听容器回环 5334。
- 页面：http://127.0.0.1:8080。

两项 DoH 地址已加入客户端设置的 DNS 下拉建议项，没有覆盖仓库默认配置。

## 已验证

- 生成配置通过 sing-box check，核心运行，容器 healthy。
- 从容器经 127.0.0.1:5330 SOCKS5 请求 gstatic generate_204 的 HTTP HEAD 返回 204，一次耗时约 1.35 秒。
- 从核心 DNS（5333）查询 www.cloudflare.com、www.taobao.com 的 A 记录均返回 NOERROR；系统 dnsmasq（53）查询也成功。
- 经 LuCI 会话鉴权的原生 API GetVersion 返回 1.14.0 / API 4。
- 页面登录 HTTP 200，实际加载的客户端 JS 含新增 DoH 选项。

## UDP 尚未通过

使用官方 StartSTUNTest，通过 main-out 发出 STUN UDP 请求；Fast-B1-1、Fast-B1-2 均返回 UDP connection refused。另一个尝试的 AnyTLS 节点 TLS-T1-1，其服务器域名返回 NXDOMAIN，因此未选用。没有继续遍历所有订阅节点。

以 direct-out 做 STUN 对照也返回 UDP write invalid argument，尚不能把 UDP 异常完全归因于节点；需要后续区分容器/宿主内核、核心 UDP 实现与上游节点能力。成功的 DNS 查询是 UDP 到本地 DNS、再经 DoH 的路径，不能冒充代理 UDP 转发已通过。

本轮不承诺 LAN 设备透明代理或 UDP 业务已可用。

## 容器调整与恢复

此前容器缺少 NET_ADMIN，且嵌套 ujail 无法创建命名空间，核心启动失败。现在只为独立 Docker 网络增加 NET_ADMIN；`dev/container-entrypoint.sh` 在开发容器内移开 /sbin/ujail，继续使用 Docker 隔离，没有开启 privileged 或 host 网络。该调整不修改生产路由器，也不属于 ujail 验收。

容器 eth0 固定为 10.253.247.2/24，网关 10.253.247.1，WAN 配为 static，bootstrap DNS 为 Docker 的 127.0.0.11。容器防火墙新增仅允许来自 Docker 网关的 TCP 80 管理入口。若以后修改 Compose 网段或实例 IP，需同步调整持久卷中的 network/firewall 配置；仅改 Compose 环境变量不会同步 UCI。

修改前的 UCI 与 HomeProxy 数据备份位于 `.dev/selected-node-check/before.tar.gz`；修改前 Compose 位于同目录的 `compose-before.yaml`。该目录还保留本轮启动及 UDP 检测记录。密码、订阅和备份不提交仓库。

## 后续：连接检查增加 UDP，复验 US-X1

服务状态的“连接检查”新增 UDP (STUN)，通过生成配置中实际的 `main-udp-out`／`main-out`／默认出站调用官方 StartSTUNTest。支持指定 STUN 服务器、25 秒超时、取消，并展示出站与错误原因。只有收到包含外部映射地址的有效绑定响应才显示通过；空结果、RPC 成功但无响应、错误均不会误报成功。不把 NAT 分类能力缺失当作 UDP 不通。

原百度/谷歌检查继续使用 wget HTTPS，页面已标注 HTTPS/TCP。它们按路由执行，没有显式固定出站。

用户指定的 8 个 US-X1 节点已逐个作为主节点执行 UDP STUN，UDP 保持 same。本轮使用 162.159.207.0:3478 避免 STUN 域名解析干扰：

| 节点 | 本轮结果 |
|---|---|
| US-X1-1 | UDP connection refused |
| US-X1-2 | UDP connection refused |
| US-X1-3 | UDP connection refused |
| US-X1-4 | 节点服务器域名解析失败（NXDOMAIN / SERVFAIL） |
| US-X1-5 | UDP connection refused |
| US-X1-6 | UDP connection refused |
| US-X1-7 | UDP connection refused |
| US-X1-8 | UDP connection refused |

全部未通过本次探测，因此恢复先前 Fast-B1-2。不能把一次 STUN 探测失败推广为所有 UDP 业务或所有网络环境都不可用。详细结果与配置备份保存在 `.dev/us-x1-check/`，没有更新或删除订阅。

新增 5 项按钮逻辑测试通过：有效响应、无有效响应、STUN 错误、取消、核心未启动。服务状态页面 HTTP 200，实际返回的 JS 与工作区一致，运行时 RPC 返回实际 UDP 出站。
