# 架构

客户端 → `server.mjs` → `protocol.mjs` → `native-bridge.mjs` → 已安装的 Kiro CLI。

`paths.mjs` 根据环境定位程序和数据，将仓库路径与运行数据完全分开。
`src/transport/capture-model.mjs` 通过仅限子进程的 Node preload，替换模型
请求内容并取得上游 Responses 风格 SSE。endpoint、身份和认证仍由原版
Kiro 管理；不会读取或持久化账号 token。

响应在进入 Kiro 的工具循环前截取，因此函数调用交给 CC/OpenCode 执行。
bootstrap 使用仓库内 `assets/bootstrap/.kiro/agents/protocol-probe.json`，
其工具、资源、MCP 和 powers 均禁用，权限规则为 deny。

每个模型请求仍启动独立 Kiro 子进程；历史由调用者提供。关联的加密
reasoning 仅按模型与调用 ID 恢复。客户端 compact 后被移除的调用不会
被重新补入历史。

`manage.mjs` 管理网关进程；安装标识由仓库绝对路径派生，防止不同检出
目录或旧安装被误认为当前服务。OpenCode 使用有独立密码的本机服务，
等待项目 MCP catalog 后再启动客户端，并在客户端退出后清理服务。

账户 token、API key、reasoning 状态、请求临时文件、客户端记录、日志、
验证结果均留在运行数据目录。Git 只跟踪代码、静态配置、文档和人工 fixture。
