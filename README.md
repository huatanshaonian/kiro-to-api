# Kiro Local Gateway

本地 Anthropic Messages 中间层，供 Claude Code 和 OpenCode 使用。代码、
传输适配、bootstrap 配置、探测工具、离线及真实客户端测试均在一个项目中。
不再依赖外部 `api-probe` 文件夹。

## 环境

- Windows，Node.js 22 或更新版本；没有第三方 npm 依赖。
- 已安装并登录的 Kiro CLI；客户端测试另需 Claude Code / OpenCode V2。
- 最近验证过的环境：Kiro CLI 2.35.1、Claude Code 2.1.312、OpenCode 2.2.0。
- 不包含 Kiro/客户端程序本体，也不包含它们的登录令牌。

## 启动

在仓库目录执行。Windows 入口优先使用 `KIRO_GATEWAY_NODE`，其次使用
已安装 Kiro 所带的 Node，最后使用 PATH 中的 Node。

```powershell
.\bin\kiro-api.cmd start
.\bin\cc-kiro.cmd
.\bin\opencode-kiro.cmd
```

默认模型是 Haiku 5.5。指定模型：

```powershell
.\bin\cc-kiro.cmd --model claude-opus-5-5
.\bin\opencode-kiro.cmd --model kiro/claude-opus-5-5
.\bin\kiro-api.cmd status
.\bin\kiro-api.cmd stop
```

也可使用 `npm start`、`npm run status`、`npm run stop`。
启动器只对本次子进程应用路由；不改原有客户端配置。OpenCode 使用独立
服务和运行目录，读取当前项目配置，并在首次请求前等待项目 MCP 目录加载。
交互审批仍由客户端处理。OpenCode 无交互 `run` 若需要自动批准，由用户
显式添加 `--auto`；启动器不默认添加。

可选的 [CC 独立审批路由](docs/APPROVAL-ROUTING.md) 保留原生 auto mode，
主对话走 Kiro、审批走 DeepSeek Flash；凭证仅从本机 provider 文件读取。

## C 盘运行版与 F 盘仓库并存

已有的 C 盘运行版与 PATH 入口保留。仓库版本验证时使用另一个端口和
数据目录，不会接管已有服务：

```powershell
$env:KIRO_GATEWAY_PORT = '18331'
$env:KIRO_GATEWAY_DATA_DIR = "$env:LOCALAPPDATA\Kiro-Gateway\f-drive-check"
.\bin\kiro-api.cmd start
```

默认端口为 `18321`，只监听 `127.0.0.1`；数据默认放在
`%LOCALAPPDATA%\Kiro-Gateway`。数据目录包括本机密钥、日志、reasoning
状态、临时请求和客户端会话，均不属于源代码仓库。
服务按仓库安装标识检查身份；相同端口有其他版本时会报错，不会悄悄接管。

PowerShell 若因执行策略阻止 `npm.ps1`，可将示例中的 `npm` 换成
`npm.cmd`；不必为此修改执行策略。

## 配置

| 环境变量 | 用途 |
|---|---|
| `KIRO_GATEWAY_DATA_DIR` | 网关与客户端的运行数据根目录 |
| `KIRO_GATEWAY_PORT` | 本机 HTTP 端口，默认 18321 |
| `KIRO_CLI_PATH` | Kiro CLI 完整路径；默认本机 LocalAppData 安装位置 |
| `CLAUDE_CLI_PATH` | Claude Code 完整路径；默认用户 `.local/bin/claude.exe` |
| `OPENCODE_CLI_PATH` | OpenCode 完整路径；默认 npm 的 `@opencode/cli` 安装位置 |
| `KIRO_GATEWAY_NODE` | `.cmd` 入口使用的 Node 完整路径 |
| `KIRO_GATEWAY_CONTEXT_TOKENS` | 本地上下文预算，默认 128000 |
| `KIRO_GATEWAY_RESERVE_TOKENS` | 输出预留预算，默认 16000 |
| `KIRO_GATEWAY_TIMEOUT_MS` | 主请求超时，默认 300000 毫秒 |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | CC 压缩窗口，启动器默认 100000 |

调整配置后须重启相应服务与客户端。密钥由首次启动自动生成，不应提交到 Git。

## 能力与边界

- 文本、多轮历史、客户端函数工具及结果回填、流式与非流式回复。
- 工具执行和审批归客户端；内置 Kiro bootstrap 的工具被禁用。
- 两个正在执行的请求、最多八个排队请求，排队超时 30 秒；支持断开取消。
- Unicode 感知的 token 估算及前置超限拒绝，不静默截断消息。
- 使用 CC/OpenCode 自身的手动及自动 compact，不另做隐藏摘要。
- reasoning envelope 按模型和调用 ID 有限持久化：24 小时、1000 项、32 MB。
- 当前上游拒绝自定义 system；系统内容作为用户上下文传入，优先级不等价。
- 缓存命中不可观测，token 和客户端费用显示是估算；上游 credits 单独记录。
- 支持内联 base64 PNG/JPEG/GIF/WebP，包括图片工具结果的历史重放及 compact。
- 图片工具结果保留调用关联、文字及原图，原图标注为不可信工具附件后投影到上游用户图片输入。
- 图片上下文按每张 4096 tokens 的本地估算预留，不把 base64 计为普通文本；不是测定的视觉用量。
- 文档、远程图片 URL、完整 thinking/effort、上游输出长度限制和 native compact 未完成。
- 128000 是本地策略预算，不是测定的上游最大窗口；compact 是有损摘要。

## 测试

```powershell
npm test
npm run check
npm run audit
```

离线测试不需要登录或联网。`tests/fixtures` 只使用人工构造的确定性协议数据，
不包含实际响应、加密 reasoning 或用户对话。

以下是真实调用，会消耗上游用量；应先设置独立端口、数据目录并启动网关：

```powershell
npm run probe
npm run test:cc
npm run test:approval
npm run test:opencode
npm run test:files
npm run test:http
npm run test:routing
npm run test:compact:cc
npm run test:compact:images
npm run test:compact:images -- --auto
npm run test:compact:cc -- --auto
npm run test:compact:opencode
npm run test:compact:opencode -- --auto
npm run verify:live -- --full
```

MCP 测试仅调用人工测试服务器；文件测试仅写独立测试目录。结果保存到
数据目录中的 `latest-*-test.json` 和 `test-results/`，不写入仓库。
普通文本/工具测试使用 Haiku；其他模型需分别验证。

## 代码位置

```text
src/                         HTTP、协议、客户端入口及运行管理
src/transport/capture-model.mjs   原 api-probe 的传输适配核心
assets/bootstrap/.kiro/agents/    禁用工具的内置 bootstrap agent
bin/                         Windows 启动入口
tests/*.test.mjs             离线回归
tests/live/                  明确调用的真实客户端/compact 测试
tools/                       独立模型探测、源码检查及验收汇总
docs/                        架构、迁移和验证记录
```

服务仍依赖当前 Kiro 的私有传输行为，升级后应重新回归。本项目未声明官方
支持或服务授权；既有账户和服务限制不会因协议兼容而消失。

参考：[CC 网关](https://code.claude.com/docs/en/llm-gateway-protocol)、
[OpenCode V2](https://opencode.ai/v2/docs/providers/)、
[OpenCode compact](https://opencode.ai/v2/docs/compaction/)。
