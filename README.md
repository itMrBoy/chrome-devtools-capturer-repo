# chrome-devtools-capturer

Claude Code 的浏览器调试 Skill —— 通过 MCP Server + Chrome 扩展，让 Claude 能够直接捕获和分析浏览器运行时数据（网络请求、控制台日志、性能 Tracing）。

## 写在前面

本plugin为claude code版本, 如果你需要codex\cursor\OpenCode\Antigravity等版本, 欢迎使用我们([tokenroll](https://github.com/TokenRollAI)) 开源的 [acplugin](https://github.com/TokenRollAI/acplugin.git) 工具进行转换。


## 工作原理

```
┌─────────────┐  stdio (MCP)  ┌──────────────┐  WebSocket  ┌──────────────┐
│ Claude Code │ ◄────────────► │  MCP Server  │ ◄──────────► │ Chrome 扩展  │
└─────────────┘               └──────────────┘             └──────────────┘
```

Skill 编排四步自动闭环工作流：

1. **`prepare_capture_session`** — 下发捕获配置给 Chrome 扩展
2. **`wait_for_capture_result`** — 自动阻塞等待扩展上报数据，无需用户手动确认
3. **`analyze_capture_results`** — 读取数据供分析（保留兼容手动模式）
4. **`cleanup_vibe_workspace`** — 阅后即焚，清理旧数据防止上下文污染

## 前置条件：安装 Chrome 扩展

Plugin 依赖 Chrome 扩展采集浏览器运行时数据，需先手动安装：

1. 克隆本仓库（如已克隆可跳过）：

```bash
git clone https://github.com/itMrBoy/chrome-devtools-capturer-repo.git
```

2. 打开 Chrome，访问 `chrome://extensions/`
3. 开启右上角 **开发者模式**
4. 点击 **加载已解压的扩展程序**，选择仓库中的 `chrome-extension/` 目录
5. 扩展安装成功后，工具栏会出现 DevTools Capturer 图标

> 扩展通过 WebSocket (`ws://localhost:8765`) 与 MCP Server 通信，无需额外配置。

## 安装 Plugin

### 通过 Plugin Marketplace 安装

在 Claude Code 中执行：

```bash
# 1. 注册 marketplace（只需一次）
/plugin marketplace add https://github.com/itMrBoy/chrome-devtools-capturer-repo

# 2. 安装插件
/plugin install chrome-devtools-capturer@chrome-devtools-capturer-repo
```

重启 Claude Code 后，Plugin 会自动完成：
- Skill 注册（Claude 识别到浏览器调试场景时自动触发）
- MCP Server 注册（通过 `.mcp.json`，无需手动 `claude mcp add`）
- 首次启动时自动安装 Node.js 依赖（通过 `start.js`）

> **注意**：`@` 后面的 marketplace 标识符以实际注册名为准。添加 marketplace 后可通过 `/plugin marketplace list` 确认。

> Skill 和 MCP Server 均由 plugin 体系自动管理，无需单独注册。

### 验证

在 Claude Code 中：
- 运行 `/mcp` 查看 `chrome-devtools-capturer` 是否显示为 **Connected**
- 输入 `/` 查看是否出现 `chrome-devtools-capturer` skill

## 更新

```bash
/plugin marketplace update chrome-devtools-capturer-repo
```

## 卸载

```bash
/plugin uninstall chrome-devtools-capturer@chrome-devtools-capturer-repo --scope user
```

## 使用场景

当你在 Claude Code 中遇到以下浏览器问题时，Skill 会自动触发：

- 页面白屏、崩溃
- 接口报错（404、500、CORS）
- JS 异常、控制台报错
- 按钮点击无反应
- 页面加载缓慢、性能问题

也可以主动描述需求，例如：

- "帮我抓一下这个页面的网络请求"
- "看看控制台有没有报错"
- "分析一下页面性能"

## 相比 Chrome DevTools 的优势

- **用户自主控制捕获时段** — 用户通过快捷键手动开始/停止录制，精确控制需要分析的时间段，避免无关数据干扰分析结论
- **AI 驱动的自动分析** — 捕获数据自动流入 Claude 进行智能分析，无需人工解读 Network/Performance 面板
- **数据脱敏** — Authorization、Cookie 等敏感信息在采集阶段自动替换为 `[MASKED]`，安全传输给 AI
- **性能数据脱水** — 原始 Tracing 数据（通常数十 MB）经 extractLongTasks 算法提炼为极简的长任务报告，只保留有诊断价值的信息
- **不依赖外部 CDP 端口** — 许多 Chromium 二开浏览器（如企业定制浏览器）禁用了 `--remote-debugging-port` 等对外暴露 CDP 的能力。本工具通过 `chrome.debugger` 扩展 API 在浏览器内部访问 CDP，数据经 WebSocket 传给 MCP Server，整条链路无需浏览器开放远程调试端口

## Token 消耗提醒

- 自动化工作流中 `wait_for_capture_result` 会将完整捕获数据返回给 Claude 上下文
- 捕获数据量取决于录制时长和页面复杂度（网络请求密集的页面可能产生数百条记录）
- Skill 默认使用 subAgent 在隔离上下文中分析数据，避免污染主对话 token 预算
- 建议：录制时间不宜过长，聚焦于需要分析的具体操作

## 项目结构

```
chrome-devtools-capturer/
├── .claude-plugin/
│   └── plugin.json               # 插件清单
├── .mcp.json                     # MCP Server 自动注册配置
├── skills/
│   └── chrome-devtools-capturer/
│       └── SKILL.md              # Skill 定义与使用指南
├── scripts/
│   ├── mcp-server/
│   │   ├── index.js              # MCP Server 主逻辑
│   │   ├── start.js              # 自动安装引导脚本
│   │   ├── package.json
│   │   └── package-lock.json
│   └── .vibeDevtools/            # 运行时工作区（自动创建）
│       └── latest_trace.json     # 捕获结果（阅后即焚）
├── chrome-extension/
│   └── utils/                    # 扩展工具模块（extractLongTasks、keepAlive 等）
├── README.md
└── LICENSE
```

## License

见 [LICENSE](LICENSE) 文件。
