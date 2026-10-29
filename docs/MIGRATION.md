# 迁移范围

本次将分散的 api-gateway 与 api-probe 运行依赖整理为一个可独立检出的项目。
Git 仓库目标为 F:/kiro-gateway；C 盘仅用于整理暂存和运行数据，未初始化 Git。

纳入：网关、协议转换、运行管理、CC/OpenCode 入口、context/reasoning/
队列、传输 preload、禁用工具的 bootstrap 配置、必要的测试和探测工具。

未纳入：原版程序、账号登录、实际 API key、用户配置、reasoning 密文状态、
聊天历史、原始响应、缓存、旧测试输出和旧备份。

原 api-probe 的 capture-model.mjs 已迁入 src/transport；最小结构化工具
探测整理为 tools/probe-model.mjs。原测试对 latest-result.json 与旧 runs
目录的依赖已删除，离线 fixture 改为人工构造的数据。

所有运行产物使用可配置数据目录。保留原 C 盘运行版和入口，没有自动
升级、覆盖或删除；F 盘验收使用单独端口和数据目录。

要将新版本用于日常运行，可先停止旧网关，再从本仓库启动；本次未执行
这一步。无需从旧目录复制账号文件或密钥，Kiro 继续使用自己的原生登录。
