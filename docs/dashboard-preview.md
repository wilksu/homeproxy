# Dashboard 访问

项目不再提供或自动下载本地 Dashboard 资源包，Compose 不再挂载静态资源或发布独立 Dashboard 端口。已有 `.dev/assets/dashboard` 仅是旧开发文件，不参与运行。

日常使用 Observability。其“设置”默认关闭局域网 API 访问，核心 API 仅监听 127.0.0.1。需要独立 Dashboard 时，开启局域网连接、设置可信来源，并在浏览器能到达的核心 API 地址上连接。官方公共入口为 https://sing-box-dashboard.sagernet.org；浏览器的 HTTPS、跨来源及本地网络访问限制仍适用。

设置应用会重启 HomeProxy。未启用服务端时不展示服务端 API 端口。高级项包含端口和 TLS 文件路径；核心密钥只在主动点击显示后呈现。外部网页不会自动获得 LuCI 登录权限。
