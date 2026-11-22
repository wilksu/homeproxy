# Dashboard 访问

日常控制在 LuCI 的 Observability 页面中完成。页面通过 Clash API 读取和控制运行中的实例。

在 Observability 的“设置”里开启“启用 sing-box gRPC API”“允许局域网访问 API”和“在本机托管官方 Dashboard”。应用后，点击“打开 sing-box Dashboard”。新标签页直接连接所选实例，LuCI 提供的密钥保存在面板所用的本地浏览器存储中。

核心在所选实例的 gRPC 端口上托管官方面板。客户端默认用 5336，服务端默认用 5337。首次启用时核心下载固定版本的面板文件，下载进度和错误会出现在核心日志里。浏览器需要能访问设置中显示的地址。

Docker 开发环境将默认 gRPC 端口发布到宿主机回环地址，容器防火墙仅允许 Docker 网桥网关访问对应端口。从宿主机的 LuCI 打开时，客户端面板使用 `http://127.0.0.1:5336`。调整开发容器的 gRPC 端口时，需要同步调整 Compose 的对应映射和容器防火墙端口。

使用原生客户端或 [官方公共 Dashboard](http://sing-box-dashboard.sagernet.org/) 时，从设置中复制 gRPC 地址并显示密钥，手动添加服务器。可在高级设置中配置 gRPC TLS 证书及私钥。
