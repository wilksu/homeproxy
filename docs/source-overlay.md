# ImmortalWrt 开发容器

开发环境使用 ImmortalWrt 25.12.0 x86/64 和 sing-box 1.14.0。Compose 只读挂载当前 HomeProxy 源码，`/etc/config` 和 `/etc/homeproxy` 使用该 Compose 项目的独立数据卷。启动会按 Compose 的地址配置容器 WAN，补齐 curl、dig 和 OpenSSL，迁移容器内的 HomeProxy 配置，并刷新 LuCI 和 RPC 缓存。

## 从另一台机器恢复

复制 `.dev/core-1.14/image.tar`、同目录的 `manifest.json` 和 `.dev/root-password`。镜像带有原来设置的 LuCI 账号，密码文件供本地登录使用。已有节点或订阅备份可以单独留存，空白开发容器只需要镜像和源码。

使用 Docker Compose 2.30 或更高版本，在仓库根目录运行：

```sh
scripts/dev.sh up
scripts/dev.sh status
```

本地缺少镜像时，脚本用 Python 3.11 或更高版本校验归档并导入镜像。第一次初始化需要能够访问镜像里的 ImmortalWrt 软件包镜像站。默认 LuCI 地址是 `http://127.0.0.1:8080`，用户名为 `root`。

脚本显式读取 `compose.yaml`。要临时使用另一份本地 Compose 配置，设置 `HP_DEV_COMPOSE_OVERRIDE` 为该文件路径。恢复副本应使用独立项目名、网段、容器地址和宿主机端口。

本机 Podman 验证使用本地文件 `.dev/compose.podman.yaml`，项目名 `homeproxy-dev`，LuCI 地址 `http://127.0.0.1:18080`。该文件同时设置了独立数据卷、网段和本机端口，以及本机 Podman 的运行兼容参数。使用已经启动的用户级 Podman 接口时：

```sh
export DOCKER_HOST="unix://$XDG_RUNTIME_DIR/podman/podman.sock"
export HP_DEV_COMPOSE_OVERRIDE=.dev/compose.podman.yaml
scripts/dev.sh up
scripts/dev.sh status
```

## 验证和日常开发

```sh
scripts/dev.sh smoke   # 在空闲容器里启动两个本机直连出站和一个可切换分组
scripts/dev.sh shell   # 进入容器
scripts/dev.sh logs    # 查看容器日志
scripts/dev.sh stop   # 停止容器并保留数据卷
```

`smoke` 在容器已有 HomeProxy 实例时退出。测试实例的 Mixed 和 Clash API 监听容器回环地址，可在 LuCI 观测页验证分组、连接和日志，容器防火墙无须接管流量。

页面目录挂载后，修改页面通常刷新浏览器即可。RPC 改动可在容器内重启 `rpcd`。编辑器原子替换单文件后，重新创建容器可让单文件挂载指向新版本，命名卷会继续使用。

`scripts/dev.sh down` 删除该项目的容器和网络并保留数据卷。旧配置升级应使用备份的副本验证。透明代理、TUN 和实体路由器上的进程隔离需要对应的宿主机或设备环境。
