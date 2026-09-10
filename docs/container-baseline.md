# 原版 HomeProxy 容器基线

当前运行环境已按后续授权挂载开发源码，见 [源码挂载说明](source-overlay.md)。下文记录的原版快照和新核心快照仍保留，镜像本身不包含源码挂载。

建立日期：2026-09-09。这里只完成原版安装与恢复基线；没有替换开发代码或新核心，没有编译。

## 当前状态：核心已替换为 1.14.0

按用户授权，当前 8080 容器已将 `/usr/bin/sing-box` 替换为官方 1.14.0 Linux amd64 musl 二进制；HomeProxy 仍是软件源原版，没有开发源码挂载。版本命令、最小配置检查和 LuCI 登录通过，尚未进行旧版 HomeProxy 配置兼容性或代理链路验证。

Compose 已指向新快照 `homeproxy-baseline:25.12.0-sb1.14.0-20260909`。镜像导出、配置备份和校验清单保存在 `.dev/core-1.14/`；原版 `.dev/baseline/` 快照保留。直接替换二进制不会修改 APK 数据库，因此包管理器仍显示 `sing-box 1.12.25-r1`，后续软件包重装或升级可能覆盖二进制。

恢复新核心镜像：`docker load -i .dev/core-1.14/image.tar`。当前 Compose 的命名卷配置另由 `.dev/core-1.14/config-backup.tar.gz` 保存；镜像本身不包含挂载卷数据。恢复原版时使用原版镜像和原版配置备份，不混用两套状态。

## 原版基线入口和版本

- 页面：http://127.0.0.1:8080
- 用户：root；密码沿用项目 `.dev/root-password`。
- 容器：`homeproxy-baseline-openwrt-1`，`restart: unless-stopped`。
- ImmortalWrt：25.12.0 r37854-4b24da3b4c5c（x86/64 用户空间）。
- 软件源 HomeProxy：26.236.50544~cb5d434。
- 软件源 sing-box：1.12.25-r1。
- 基础镜像：`immortalwrt/rootfs@sha256:2bd944e34e37e86fc5b2750ca7805ab350167b2895aae6e7ca158162f5906c14`。

在无挂载的干净容器中执行 `apk update` 和 `apk add luci-app-homeproxy`，由软件源安装依赖与执行安装脚本。此次新增 kmod-nf-tproxy、kmod-nft-tproxy、kmod-inet-diag、kmod-netlink-diag、kmod-tun、sing-box、ucode-mod-digest、luci-app-homeproxy；没有跳过依赖校验。其他依赖已由基础镜像提供。

当前 Compose 使用安装后的本地快照，不再调用之前的开发初始化脚本，不挂载工作区，不下载 1.14 核心，也不启动测试核心。`/etc/config` 和 `/etc/homeproxy` 使用独立命名卷。旧的开发容器已停止，其数据卷保留。

## 已验证与边界

从安装快照新建容器及全新数据卷后，确认容器 healthy、LuCI 密码登录成功、HomeProxy 客户端/节点/服务端/状态页面返回 HTTP 200、HomeProxy ubus 对象可用、核心版本为 1.12.25，并核对 HomeProxy 配置与快照一致。详细结果在 `.dev/baseline/verification.json`。

未配置任何代理节点，所以 HomeProxy 为 `active with no instances`，没有代理进程接管流量。上述验证是安装和管理界面的基线，不是实际代理链路验收。

容器共享宿主机内核。原版启动会报告网络管理权限不足；当前没有赋予特权或 NET_ADMIN。依赖包中的 OpenWrt 内核模块已安装，但这不代表它们能在宿主机内核加载，界面特性探测也不能证明透明代理可用。保留这一限制以便后续区分容器条件与代码问题。

## 快照与备份

快照标签：`homeproxy-baseline:25.12.0-sb1.12.25-20260909`。

镜像 ID：`sha256:d93e653939b0434f576046f1c3807c3d87df5069c207753bc4f4989ef99cd4bd`。

项目 `.dev/baseline/` 下保存：

- `image.tar`：可通过 docker load 恢复的完整安装镜像。
- `config-backup.tar.gz`：UCI、HomeProxy 数据、账户和 APK 软件源配置备份。
- `manifest.json`：版本、镜像 ID、各备份文件的 SHA-256。
- `install.log`、`packages.txt`、`versions.txt`：安装记录及完整已安装包清单。
- `runtime.json`、`service.txt`、`verification.json`：功能探测、服务状态、恢复验证结果。

这些是本地开发备份，含账户配置；目录已限制访问并由 `.gitignore` 排除，不提交仓库。

## 常用操作

在项目根目录执行：

```sh
scripts/dev.sh up       # 启动现有原版基线，不编译
scripts/dev.sh shell    # 进入容器
scripts/dev.sh logs     # 查看日志
scripts/dev.sh stop     # 停止并保留容器与数据
```

`docker compose down` 会删除容器和网络，默认保留命名卷。重建时挂载的仍是现有数据；不要把普通重建误认为恢复干净配置。

要从文件恢复镜像，并在另一个端口创建一份全新的基线副本：

```sh
docker load -i .dev/baseline/image.tar
HP_DEV_HTTP_PORT=18080 HP_DEV_SUBNET=10.253.248.0/24 HP_DEV_GATEWAY=10.253.248.1 docker compose -p homeproxy-baseline-restore up -d --no-build --wait
```

不同的 Compose 项目名会创建新的数据卷，从快照初始化；不会覆盖当前 8080 环境。副本访问地址为 http://127.0.0.1:18080，登录密码与快照一致。后续开发替换应在副本中进行，本轮未执行。

## 开发网络

Compose 默认固定使用 `10.253.247.0/24`，网关 `10.253.247.1`。已移除此前自动分配的 `192.168.0.0/20`，避免覆盖其他任务访问的局域网地址。修改网段后需要重建 Compose 网络，保留命名卷即可保留配置。并行恢复副本必须使用不同且不冲突的网段，上面的恢复命令已指定独立网段。
