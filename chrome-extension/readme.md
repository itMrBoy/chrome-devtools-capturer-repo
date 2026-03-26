# chrome-devtools-capturer — Chrome Extension

## 文件结构

```
chrome-extension/
├── manifest.json
├── popup.html
├── popup.js
└── background.js
```

## 交互方式

点击扩展图标打开弹窗，弹窗实时显示当前状态和操作按钮：

| 状态 | 弹窗提示 | 按钮 |
|---|---|---|
| `UNARMED` | 等待 MCP Server 下发配置 | 禁用（灰色） |
| `ARMED` | 配置已就绪，目标：xxx | ▶ 开始录制（绿色） |
| `CAPTURING` | 录制中，请执行目标操作… | ⏹ 停止并上报（红色） |

弹窗同时显示：
- MCP Server 连接状态（绿点/灰点）
- 最新操作结果（成功上报条数、错误原因等）
- 快捷键提示 `Alt+Shift+C`

## 架构概览

```
MCP Server (Node.js)
    │  ws://localhost:6666
    │  下发配置 ──────────────────────────────────► background.js
    │                                                    │
    │                                             chrome.debugger.attach
    │                                                    │
    │                                             CDP 事件流
    │                                             Network.requestWillBeSent
    │                                             Network.responseReceived
    │                                             Log.entryAdded
    │                                                    │
    │  ◄─────────────────────────────────── 上报 trace JSON
```

## 状态机

| 状态 | 徽标 | 含义 |
|---|---|---|
| `UNARMED` | 无（灰） | 初始态，等待 MCP Server 下发配置 |
| `ARMED` | `RDY`（琥珀） | 已收到配置，等待快捷键触发 |
| `CAPTURING` | `REC`（红） | debugger 已 attach，正在录制 |

## 快捷键

| 按键 | 当前状态 | 行为 |
|---|---|---|
| `Alt+Shift+C` | `ARMED` | attach debugger，开启 Network + Log 域，切换为 `CAPTURING` |
| `Alt+Shift+C` | `CAPTURING` | detach debugger，打包数据通过 WS 上报，切换为 `UNARMED` |
| `Alt+Shift+C` | `UNARMED` | 提示等待配置，无操作 |

> 快捷键可在 `chrome://extensions/shortcuts` 中自定义。

## 推荐工作流

1. 启动 MCP Server（`node mcp-server/index.js`）
2. 在浏览器中加载本扩展
3. Claude 调用 `prepare_capture_session` → 扩展进入 `ARMED` 态
4. 切换到目标页面，按 `Alt+Shift+C` 开始录制
5. 执行需要捕获的操作
6. 再次按 `Alt+Shift+C` 停止录制，数据自动发送给 MCP Server
7. Claude 调用 `analyze_capture_results` 读取分析结果

## CDP 数据采集

### Network

| CDP 事件 | 提取字段 |
|---|---|
| `Network.requestWillBeSent` | `url` `method` `headers` `startTime` `type` |
| `Network.responseReceived` | `status` `statusText` `mimeType` `headers` `durationMs` |

> 两个事件通过 `requestId` 关联合并。捕获结束时仍无响应的请求以 `status: null` 标记保留。

### Console

| CDP 事件 | 提取字段 |
|---|---|
| `Log.entryAdded` | `level` `source` `text` `url` `line` `timestamp` |

`level` 枚举：`verbose` / `info` / `warning` / `error`

`source` 枚举：`javascript` / `network` / `console-api` / ...

## 脱敏规则

敏感字段在写入结果前自动替换，不上报原始值：

| 场景 | 规则 |
|---|---|
| 请求头 `Authorization` | 值替换为 `[MASKED]` |
| 请求头 `Cookie` | 值替换为 `[MASKED]` |
| 响应头 `Set-Cookie` | 值替换为 `[MASKED]` |
| 日志文本中的 `Authorization: Bearer xxx` | token 部分替换为 `[MASKED]` |
| 日志文本中的 `Cookie: xxx` | 值替换为 `[MASKED]` |

## 上报数据结构

```json
{
  "meta": {
    "capturedAt": "2026-03-26T10:00:00.000Z",
    "tabId": 123,
    "config": { "target": "...", "types": [...], "action_mode": "reload" },
    "source": "chrome-devtools-capturer-extension",
    "stats": { "network_count": 42, "console_count": 7 }
  },
  "network_logs": [
    {
      "requestId": "...",
      "url": "https://example.com/api/data",
      "method": "GET",
      "type": "Fetch",
      "status": 200,
      "statusText": "OK",
      "mimeType": "application/json",
      "headers": { "content-type": "application/json" },
      "startTime": 1711447200000,
      "durationMs": 342
    }
  ],
  "console_logs": [
    {
      "level": "error",
      "source": "javascript",
      "text": "Uncaught TypeError: Cannot read properties of undefined",
      "url": "https://example.com/static/main.js",
      "line": 42,
      "timestamp": "2026-03-26T10:00:01.500Z"
    }
  ]
}
```

## 安装方式

1. 打开 `chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本目录（`chrome-extension/`）

## 异常处理

| 场景 | 处理方式 |
|---|---|
| `chrome.debugger` 被 DevTools 占用 | 捕获错误，通过 action title 提示用户，不崩溃 |
| 外部强制 detach（用户打开 DevTools） | 监听 `onDetach` 事件，自动回退到 `UNARMED` |
| WS 连接断开 | 指数退避重连（1s → 2s → … 上限 30s） |
| 请求发出但无响应（捕获期间未完成） | 以 `status: null` 保留在结果中，不丢弃 |
