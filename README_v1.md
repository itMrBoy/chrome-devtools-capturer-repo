# chrome-devtools-capturer

VibeProfiler (Vibe Coding DevTools 抓取器)

绕过cdp，采用MCP + chrome extension的方式，主动捕获控制台、network、performance profile等信息，用于web、extension等项目，vibe coding过程中排查bug、性能优化的上下文补充，让llm分析更有事实依据。

## 1. 背景与目标

在无外部 CDP (Chrome DevTools Protocol) 支持的定制 Chromium 132 浏览器环境下，开发浏览器扩展（特别是涉及大量 DOM 遍历的脱敏扩展等）和 Web 应用时面临调试信息获取瓶颈。
**核心目标**：构建一个“浏览器扩展 + 本地 Node.js MCP 服务”工具链，利用扩展内部的 `chrome.debugger` API 绕过外部端口限制。通过 LLM 智能预配置、开发者一键录制、本地格式化落盘（如 HAR 格式）和正则脱敏，为 LLM 提供结构化上下文，实现流畅的 Vibe Coding。

## 2. 系统架构 (两端一桥)

系统由以下两个核心组件构成，通过 WebSocket 进行本地双向通信：

1. **Local MCP Server (本地 Node.js 服务)**：暴露 MCP Tools，维护状态机，负责下发配置、接收数据并落盘到 `.vibe_context/` 目录。

2. **VibeProfiler Extension (浏览器扩展 Manifest V3)**：接收配置进入待命态，监听快捷键触发 `chrome.debugger.attach`，抓取 CDP 数据流，执行本地脱敏，并将其格式化为 LLM 友好的结构后回传。

## 3. 核心业务流程 (预武装模式 Pre-Armed Pattern)

- **Step 1: 智能预配置 (LLM)**：调用 `prepare_capture_session` 下发抓取参数。
- **Step 2: 开发者抓取 (User)**：浏览器中按快捷键（如 `Cmd+Shift+K`）。支持**Interactive（交互抓取）**与**Reload（冷启动刷新抓取）**模式。
- **Step 3: 收网分析 (LLM)**：开发者通知完成后，LLM 调用 `analyze_capture_results` 读取数据。

## 4. MCP Tools 接口定义

### 4.1 Tool: `prepare_capture_session`

- **描述**: 配置扩展抓取参数并使其待命。
- **参数 (JSON)**:

```json
{
  "target": "page", // "page" 或 "extension"
  "types": ["network", "console", "performance"], 
  "action_mode": "interactive", // "interactive" 或 "reload"
  "network_filters": ["XHR", "Fetch", "Document"] // 借鉴 agent-browser，过滤无用静态资源
}
```

### 4.2 Tool: analyze_capture_results

描述: 读取最近一次抓取并脱敏后的 DevTools 数据。

返回值: 格式化后的上下文集合。

## 5. 数据处理与输出格式 (借鉴业界最佳实践)

Network 数据: 扩展端拦截 Network.requestWillBeSent 和 Network.responseReceived 后，必须组装成标准 HAR (HTTP Archive) 格式的精简版返回，便于 LLM 原生解析。

脱敏规则: 强制正则替换 HTTP Header 中的 Authorization、Cookie 字段，以及 Body 中的常见敏感信息（如手机号、身份证号）。

Performance 数据: 过滤底层的 V8 引擎杂音，仅输出耗时大于 50ms 的 Long Task 及其主要的 Call Frame。
