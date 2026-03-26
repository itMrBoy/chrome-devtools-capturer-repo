# chrome-devtools-capturer — MCP Server

## 文件结构

```
chrome-devtools-capturer/
├── mcp-server/
│   ├── package.json
│   └── index.js
└── .vibeDevtools/          ← 运行时自动创建
    └── latest_trace.json   ← 由扩展写入，分析后删除
```

## 关键设计说明

| 模块 | 说明 |
|---|---|
| MCP Transport | 使用 `StdioServerTransport`，符合 Claude Desktop / claude-code 标准接入方式 |
| WebSocket Server | 独立监听 `ws://localhost:6666`，与 MCP stdio 互不干扰 |
| `prepare_capture_session` | 广播配置给所有已连接扩展，返回操作引导；未连接时给出明确警告 |
| `analyze_capture_results` | 读取 `.vibeDevtools/latest_trace.json`，文件不存在时返回引导提示 |
| `cleanup_vibe_workspace` | 删除 `latest_trace.json`，阅后即焚，防止旧数据污染后续大模型上下文 |
| WS 消息处理 | 收到扩展发来的 JSON 后，格式化（2空格缩进）覆盖写入 trace 文件 |
| 日志 | 所有运行日志写入 `stderr`，不污染 MCP 的 stdout 通信信道 |

## 推荐工作流

1. `prepare_capture_session` — 下发配置给扩展
2. 在浏览器中操作目标页面
3. `analyze_capture_results` — 读取并分析捕获结果
4. `cleanup_vibe_workspace` — 删除 trace 文件，保持工作区干净

## MCP Tools 参数一览

### `prepare_capture_session`

| 参数 | 类型 | 说明 |
|---|---|---|
| `target` | `string` | 目标页面 URL 或标识符 |
| `types` | `string[]` | 捕获类型，例如 `["network", "console", "performance"]` |
| `action_mode` | `string` | 触发模式：`auto` \| `manual` \| `record` |

### `analyze_capture_results`

无参数。

### `cleanup_vibe_workspace`

无参数。

## 安装与启动

```bash
cd mcp-server
npm install
node index.js
```

## 接入 Claude Desktop

在 `claude_desktop_config.json` 中添加：

```json
{
  "mcpServers": {
    "chrome-devtools-capturer": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/index.js"]
    }
  }
}
```
