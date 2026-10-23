# 原生订阅导入的数据约定

导入不是 JSON 原文透传。只有能由节点模型、编辑器和生成器共同保留含义的配置才接受；不支持的字段明确拒绝，原有节点由更新事务保留。核心接受原始配置，只证明输入有效，不能证明转换后的配置或页面保存结果正确。

## 归一化边界

归一化放在 `node_import.uc`，在写入 UCI 前完成。UCI 中只存表单能表示的字符串和非空字符串列表，不存 JSON `null`、嵌套对象或含混的单选数组。

| 原生输入 | 节点模型中的表示 |
| --- | --- |
| Shadowsocks `network` 为 `tcp`、`udp` 或对应单元素数组 | 单个协议字符串 |
| 两种协议的数组（顺序不限）、空数组、`null`、缺省 | 不设置限制，使用核心默认的 TCP 和 UDP |
| 重复的相同协议 | 去重后使用单个协议字符串 |
| 可选字段的合法 `null`、可选列表的空数组 | 不写入对应 UCI 选项 |
| ALPN、SSH 密钥等列表字段的单值或数组 | 统一为有序列表；拒绝页面无法保留的空项、非字符串项 |
| TLS uTLS 的 `enabled` 缺省、`null` 或 `false` | 保持关闭；不会凭空启用指纹 |
| 1.14.0 中等价于 Chrome 的五个兼容指纹名称 | 规范名称 `chrome`，编辑器可识别 |
| HTTP 传输的 Host 请求头 | 有序字符串列表；WebSocket、HTTP、HTTPUpgrade 使用列表编辑器 |
| 显式关闭 UDP 分片 | 保留 `0`，生成 `false`，不能用缺省代替 |
| VMess 缺省的 global padding | 显式保存关闭，避免编辑器的新建节点默认值将其开启 |

空值归一化不会绕过对原始输入的核心检查：例如核心不接受 `routing_mark: null` 或空的超时值时，导入仍然拒绝。不支持的其他传输头也仍然明确拒绝。数组中的非字符串和不能表示的对象不会通过字符串拼接存入 UCI。

上述核心语义以配对的 sing-box 1.14.0 为准：[NetworkList](https://github.com/SagerNet/sing-box/blob/v1.14.0/option/types.go)、[uTLS 指纹实现](https://github.com/SagerNet/sing-box/blob/v1.14.0/common/tls/utls_client.go)、[VMess 默认值](https://github.com/SagerNet/sing-box/blob/v1.14.0/protocol/vmess/outbound.go)。升级配对核心时需要重核这些约定。

## 验证要求

新增导入字段时，需要覆盖原始 JSON → 导入模型 → 实际生成器 → 配对核心检查，并断言配置含义。只断言核心返回成功会漏掉协议限制、布尔默认值等被改变的问题。

影响编辑器的字段还要验证页面无改动保存、刷新后的值；单选项必须覆盖缺省、每个选项、合法数组和空值，列表必须覆盖单值、多个值及顺序。自动测试使用虚构地址和凭据，真实订阅及设备配置不进入公开测试或 CI。
