# Claude Code 独立审批路由

普通对话和客户端工具回路走 Kiro；Claude Code 原生 auto mode 的独立 classifier 请求可转到 DeepSeek Flash。网关不执行用户工具，不重新实现审批提示词、规则或判定解析。

## 本机配置

在网关运行数据目录创建 `approval-routing.local.json`（不纳入 Git）：

```json
{
  "enabled": true,
  "providerSettingsFile": "C:/path/to/cc-environments/deepseek/settings.json",
  "timeoutMs": 45000
}
```

provider 文件使用 `env.ANTHROPIC_BASE_URL`（`https://api.deepseek.com/anthropic`）和 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`。凭证在每次请求时读取，支持轮换；配置文件本身只需引用位置。仅允许 DeepSeek HTTPS 端点，以及供离线测试使用的 HTTP loopback，禁止重定向。

配置存在并启用时，仓库内 CC 启动器为本次客户端设置：

- `CLAUDE_CODE_AUTO_MODE_MODEL=deepseek-flash[1m]`；只影响原生审批。
- `CLAUDE_CODE_AUTO_MODE_SERVER=0`；由 CC 客户端发送独立 classifier 请求。
- 默认 `permissions.defaultMode=auto`，可用显式 `--permission-mode manual`、`plan` 等覆盖。
- `ENABLE_TOOL_SEARCH=false`，避免当前 DeepSeek/CC 工具搜索协议不兼容。

本机已有统一 CC 启动器时，应应用相同的本次进程覆盖，继续共享 Claude 记忆和记录；不要创建独立 Claude 配置目录。未启用本配置时，仓库内启动器保持原有权限模式选择。

## 请求处理

审批使用独立模型标识 `deepseek-flash`（可带 `[1m]`），同时必须具有原生 security-monitor system 提示特征、最多两条消息、非流式，以及无普通工具或仅有 `classify_result`。普通对话、子代理或工具请求不能用这个标识转发。主模型与 `/model` 切换仍走原 Kiro 路径。

审批在 Kiro 协议转换、上下文预算和推理队列之前分流，因此不继承 Kiro 的 system 降级，也不受其本地上下文预算限制。网关保留 classifier policy、对话、prefill 和评分格式，改用 DeepSeek 模型并关闭这一路的 thinking。响应原样交给 CC 解析。

本机 API key 仅验证入口；上游请求单独使用 DeepSeek 认证，不能转发本机 key。HTTP 错误、超时、断连和非法 Messages 响应都保持错误；路由器不生成允许判断，也不把失败转给 Kiro。CC 自身的重试、模型回退和最终审批行为仍由客户端版本控制，不能据 HTTP 错误传递测试声称全部失败场景均已端到端验证。

`requests.jsonl` 用 `route=deepseek-approval` 记录模型、状态、耗时和上游 usage；`route=kiro` 记录普通推理。不得记录审批 policy、用户对话或认证值。CC 显示的模型费用不视为 DeepSeek 实际账单。

## 验证

`npm test` 包含普通请求隔离、认证隔离、原始 verdict 保留、凭证轮换、非法配置、HTTP 错误、超时和断连测试。

在独立端口和数据目录配置本机 provider 后运行 `npm run test:approval`，会实际调用 Kiro 和 DeepSeek。测试检查 CC 原生 classifier 日志、两条上游路由、受控标记文件及最终回复，不向客户端添加跳过审批参数。拒绝质量、二阶段判定及长上下文仍需要专门评测。
