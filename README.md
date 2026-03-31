# chrome-devtools-capturer

Claude Code 的浏览器调试 Skill —— 通过 MCP Server + Chrome 扩展，让 Claude 能够直接捕获和分析浏览器运行时数据（网络请求、控制台日志、性能 Tracing）。

## 工作原理

```
┌─────────────┐  stdio (MCP)  ┌──────────────┐  WebSocket  ┌──────────────┐
│ Claude Code │ ◄────────────► │  MCP Server  │ ◄──────────► │ Chrome 扩展  │
└─────────────┘               └──────────────┘             └──────────────┘
```

Skill 编排三步闭环工作流：

1. **`prepare_capture_session`** — 下发捕获配置给 Chrome 扩展
2. **`analyze_capture_results`** — 读取扩展上报的运行时数据供 Claude 分析
3. **`cleanup_vibe_workspace`** — 阅后即焚，清理旧数据防止上下文污染

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
├── README.md
└── LICENSE
```

## License

见 [LICENSE](LICENSE) 文件。
