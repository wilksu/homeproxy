# 自动测试

优先对公开函数的输入和输出做断言；只有跨组件的行为才启动生成器、核心或隔离的更新事务。测试代码和替身都放在 `tests/`，不向应用添加测试开关、依赖或分支，不使用真实订阅和设备配置。

## 本地运行

前端测试使用 Node.js 自带的测试器：

```sh
npm test
```

后端单元测试只需要带 `fs`、`math` 模块的 ucode，不需要安装或运行 sing-box：

```sh
UCODE=/usr/bin/ucode python3 scripts/test-python.py --suite unit
UCODE=/usr/bin/ucode python3 scripts/test-python.py --suite unit -k network
UCODE=/usr/bin/ucode python3 scripts/test-python.py --suite guards
```

`-k` 按测试名称筛选，支持子串和 `*` 通配符。依赖缺失、用例被跳过、筛选结果为空都会失败，不能把未执行误报为通过。

集成测试另外需要配对的 sing-box 1.14.0、curl 和 openssl。核心不需要常驻运行；测试自行创建临时配置，网络用例只连接本机测试服务。

```sh
UCODE=/usr/bin/ucode SING_BOX=/usr/bin/sing-box python3 scripts/test-python.py --suite integration
UCODE=/usr/bin/ucode SING_BOX=/usr/bin/sing-box python3 scripts/test-python.py
```

最后一条包含单元、反向检查和集成测试。在现有开发容器中执行时，把源码放在容器的 `/tmp` 下运行；不要覆盖 `/etc` 或正在使用的配置。生产包仍由 CI 构建。

## 防护与断言

| 风险 | 单元或前端断言 | 跨组件验证 |
| --- | --- | --- |
| 清空订阅、过滤列表时保存失败 | `node-references.test.mjs`：空列表走删除选项，保存失败保留页面状态 | 原有订阅清理、策略测试 |
| `network` 数组或 `null` 改变协议 | `unit/test_node_import.py`：缺省、空值、单项、双项、顺序、重复及非法类型 | `test_subscription_import.py`：原始输入核心检查、生成结果及协议含义 |
| `insecure=0/false` 被当成开启 | `unit/test_share_links.py`：明确布尔值矩阵及 RPC/订阅解析一致性 | 共享解析结果进入现有生成测试 |
| HTTPS 等协议缺省端口错误 | 同上：协议 × 域名/IPv4/IPv6 × 缺省/空/显式端口 | `test_share_link_generation.py`：生成的端口、TLS 和真实核心 |
| 无效 SS 加密方式或身份字段被接受 | 同上：多种编码的拒绝用例；缺失密码/身份字段；RPC 一致性 | 编辑器每种 SS 加密方式通过真实核心 |
| 密码、名称或嵌套 URL 被截断、重复解码 | 同上：对确定性的编码组合断言原始值，而不是只断言导入成功 | 生成结果再次断言路径、密码、名称 |
| 带端口或 IPv6 的 Host 不能保存 | `node-import-fields.test.mjs`：接受、拒绝矩阵与三个字段绑定 | 原生导入/生成保留 Host 顺序及内容 |
| 大订阅被截断后清理旧节点 | `unit/test_command_output.py`：512 KiB 前/等于/后边界，高文件描述符 | `test_subscription_integrity.py`：明文/Base64 超限、缺状态、传输失败均不提交且保留全部旧节点 |
| 共享节点图反复递归、缓存掩盖错误 | `unit/test_node_model.py`：读取次数、循环、缺失引用、异常后复用、模型生命周期 | 生成器和引用完整性测试 |
| 转换成功但原始配置非法，或更新后无法启动 | 转换单元测试只证明转换约定，不替代核心校验 | 原始/生成配置分别由真实核心检查；事务覆盖失败、回滚、并发修改及服务状态 |

`tests/guards/test_regressions.py` 在临时副本中逐项恢复九种错误：SS 方式校验缺失、HTTPS 端口错误、无限次分隔 `://`、Hy2 布尔字符串误判、Base64 密码重复解码、名称重复编码、network 数组原样存储、null 不再忽略、截断前缀被接受。每项先证明原版对应测试通过，再要求改坏后的同一个测试出现断言失败。变体不能编译、运行异常、跳过或替换锚点失效，均使检查失败。

## 测试边界与效率

ucode 测试执行实际解析器和转换器。共享测试适配器只在临时副本中替换依赖 OpenWrt `/sbin/validate_data` 的校验函数，并提供 LuCI 编码、UCI 等外部模块替身；这些替身不证明 OpenWrt 原生校验器或真实浏览器行为。编码断言使用预期原文，转换器测试不会用假核心返回成功来冒充验证。`importNode` 单元测试与负责原始核心校验的 `importNodes` 集成测试分别运行。

固定地址、虚构凭据和确定性组合让失败可复现。批量输入在一次解释器调用中检查，避免为每个排列启动核心或浏览器；原有核心、更新、回滚测试继续保留。新增字段应补语义断言和拒绝用例，不能只增加“执行成功”的计数。

CI 顺序执行单元、反向检查、集成，全部通过后构建 APK/IPK 并运行前端测试。不安装浏览器或新增第三方测试框架；同一 PR 的旧运行会被取消，后端任务最多运行 20 分钟。ucode 和核心仍固定版本并核对下载摘要。浏览器缓存、LuCI 检查式应用的确认请求、真实设备网络行为属于独立验收范围，不能用单元测试通过替代。
