# 当前源码挂载

当前 `compose.yaml` 在原版 HomeProxy + 官方 1.14.0 核心快照上，只读挂载 HomeProxy 页面、公共 JS、脚本目录、启停脚本、菜单、ACL、RPC 模块、API CGI 和版本清单。没有覆盖整个 /www、/etc 或 /usr/share。

`/etc/config`、`/etc/homeproxy` 继续使用原数据卷；只有后者的 scripts 子目录被源码挂载覆盖。挂载前的配置备份及旧 Compose 在 `.dev/before-source-mount/`。首次接入执行了带备份的 1.14 配置迁移；没有将仓库默认 UCI 覆盖到现有配置。

Compose 的 post_start 调用 `dev/setup-mounted.sh`：等待 rpcd、补齐 curl/bind-dig、准备密钥、执行幂等迁移、清缓存并重启 rpcd/uhttpd。没有编译任务，也不启动代理进程。官方 Dashboard 资源现已通过 `.dev/assets/dashboard` 只读挂载到 `/usr/share/homeproxy/dashboard`，访问地址为 http://127.0.0.1:8081/dashboard/ 。

验证结果：容器 healthy，登录和 client/node/observability/api-settings 路由返回 HTTP 200，服务端实际提供的 JS 与工作区文件哈希一致，runtime RPC 返回 1.14.0。后续已通过独立临时浏览器验证观测页、窄屏和键盘导航，可在 http://127.0.0.1:8080 查看。

目录挂载下的页面修改通常刷新浏览器即可。RPC 修改后重启 rpcd；菜单变更需清 LuCI 缓存。单文件 bind mount 若遇到编辑器原子替换文件，可能仍指向旧 inode，需要 `docker compose up -d --no-build --force-recreate --wait` 重新挂载。翻译仍使用原版安装包中的语言资源，本轮没有编译新的语言文件。

后续已按用户授权配置并启动真实订阅节点；当前运行与容器权限调整见 [节点验证记录](selected-node-validation.md)。本页前述“没有代理进程”仅描述最初挂载时的状态。
