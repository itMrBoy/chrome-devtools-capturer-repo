# chrome-devtools-capturer

VibeProfiler (Vibe Coding DevTools 抓取器)

绕过cdp，采用MCP + chrome extension的方式，主动捕获控制台、network、performance profile等信息，用于web、extension等项目，vibe coding过程中排查bug、性能优化的上下文补充，让llm分析更有事实依据。

## 1. 背景与目标
在无外部 CDP 支持的定制 Chromium 132 浏览器环境下，开发 Web 应用及脱敏扩展时缺乏有效的自动化调试上下文。
**核心目标**：构建一个“浏览器扩展 + 本地 Node.js MCP 服务”工具链。拥抱 Agentic Workflow，为主 Agent（如 Cursor/Claude Code）提供获取浏览器深层运行数据的 Skills（工具），并通过规范的本地临时存储与清理机制，实现零上下文污染的 Vibe Coding 体验。

## 2. 系统架构 (Agentic Workflow)
系统由以下组件构成，形成闭环工作流：
1. **主 Agent (IDE)**：负责核心代码逻辑编写，遇到瓶颈时决策调用 MCP Tools。
2. **Local MCP Server (Node.js)**：
   - 暴露 Skills 供主 Agent 调用。
   - 负责与浏览器扩展的 WebSocket 通信。
   - **状态与存储管理**：将抓取的数据落盘至项目根目录的 `.vibeDevtools/` 临时文件夹，并在消费后执行清理（阅后即焚）。
3. **VibeProfiler Extension (Manifest V3)**：
   - 接收指令进入“预武装”状态。
   - 监听快捷键触发 `chrome.debugger.attach`。
   - 捕获 Console、Network 数据流（Performance 深度过滤将在后续版本迭代），执行基础脱敏后回传。

## 3. 核心业务流程
- **Step 1: 智能预配置**：主 Agent 调用 `prepare_capture_session` 下发参数（目标页面、抓取类型、冷启动/交互模式）。
- **Step 2: 开发者抓取**：用户在浏览器中通过快捷键或者按钮控制录制起止。扩展将数据回传，Node 服务将其存入 `.vibeDevtools/latest_trace.json`。
- **Step 3: 消费与分析**：主 Agent（或唤起 Sub-agent）调用 `analyze_capture_results` 读取结构化报告进行 Bug 排查。
- **Step 4: 现场清理**：主 Agent 阅毕后，调用 `cleanup_vibe_workspace` 删除临时文件，保持上下文卫生。

## 4. MCP Tools 接口定义

### 4.1 Tool: `prepare_capture_session`
- **参数 (JSON)**: `{ "target": "page" | "extension", "types": ["network", "console", "performance"], "action_mode": "interactive" | "reload" }`
- **功能**: 下发配置至扩展，返回提示语引导用户去浏览器操作。

### 4.2 Tool: `analyze_capture_results`
- **参数**: 无。
- **功能**: 读取 `.vibeDevtools/latest_trace.json`，返回格式化后的 DevTools 数据。

### 4.3 Tool: `cleanup_vibe_workspace` (新增)
- **参数**: 无。
- **功能**: 删除 `.vibeDevtools` 目录下的所有临时 Trace 文件，返回清理成功的回执。

