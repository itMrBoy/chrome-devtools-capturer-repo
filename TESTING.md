# 测试清单 — chrome-devtools-capturer

## 环境准备

- [ ] Node.js 已安装（≥ 18）
- [ ] 在 `mcp-server/` 下执行 `npm install`，确认 `@modelcontextprotocol/sdk` 和 `ws` 已安装
- [ ] Chrome 已安装，`chrome://extensions/` 开发者模式已开启
- [ ] 扩展已从 `chrome-extension/` 目录加载，无报错

---

## 阶段一：MCP Server 独立测试

**WebSocket Server 启动**
- [ ] 执行 `node index.js`，stderr 输出 `[WS] WebSocket server listening on ws://localhost:8765`
- [ ] 执行 `node index.js`，stderr 输出 `[MCP] Server connected via stdio transport`
- [ ] 用 `wscat -c ws://localhost:8765` 或浏览器 DevTools 连接，确认握手成功

**文件系统**
- [ ] 首次启动后 `.vibeDevtools/` 目录自动创建
- [ ] 通过 WS 发送任意 JSON 字符串，确认 `latest_trace.json` 被写入且格式化（2空格缩进）
- [ ] 连续发送两条消息，确认第二条覆盖第一条（而非追加）
- [ ] 发送非法 JSON 字符串，确认 Server 不崩溃，stderr 输出错误日志

**MCP Tool：`prepare_capture_session`**
- [ ] 无 WS 客户端连接时调用，返回包含 `⚠️` 的警告文案
- [ ] 有客户端连接时调用，客户端收到完整 payload `{ target, types, action_mode }`
- [ ] 有客户端连接时调用，返回包含 `✅` 和浏览器操作引导的文案

**MCP Tool：`analyze_capture_results`**
- [ ] `latest_trace.json` 不存在时调用，返回包含 `⚠️` 的提示
- [ ] 文件存在时调用，返回文件原始内容字符串

**MCP Tool：`cleanup_vibe_workspace`**
- [ ] 文件不存在时调用，返回"已是干净状态"提示，不报错
- [ ] 文件存在时调用，文件被删除，`.vibeDevtools/` 目录本身保留
- [ ] 清理后再次调用 `analyze_capture_results`，返回文件不存在提示

---

## 阶段二：Chrome 扩展独立测试

**WebSocket 连接**
- [ ] MCP Server 未启动时加载扩展，Service Worker 日志显示连接失败并开始重连
- [ ] 启动 MCP Server 后，扩展自动重连成功，日志输出 `[WS] Connected`
- [ ] 关闭 MCP Server，扩展检测到断线并开始指数退避重连

**状态机与徽标**
- [ ] 初始状态徽标为空（灰色），title 为 `UNARMED`
- [ ] MCP Server 发送配置后，徽标变为琥珀色 `RDY`，title 变为 `ARMED`
- [ ] `Alt+Shift+C` 触发后，徽标变为红色 `REC`，title 变为 `CAPTURING`
- [ ] 再次按 `Alt+Shift+C`，徽标恢复为灰色，title 变为 `UNARMED`
- [ ] `UNARMED` 状态下按快捷键，title 提示等待配置，无其他副作用

**Popup 交互**
- [ ] 点击扩展图标，弹窗正常打开
- [ ] `UNARMED` 时：弹窗显示"等待配置"文案，MCP Server 连接状态正确，按钮禁用
- [ ] MCP Server 下发配置后，弹窗实时更新为 `ARMED`，目标 URL 显示在提示中，按钮变为绿色"▶ 开始录制"
- [ ] 点击"▶ 开始录制"，与按快捷键效果等同，弹窗切换为红色"⏹ 停止并上报"
- [ ] 点击"⏹ 停止并上报"，弹窗显示上报成功文案（含 network/console 条数）
- [ ] MCP Server 断开时，弹窗 WS 指示灯变灰，显示重连提示
- [ ] 关闭弹窗后重新打开，状态与当前 background 一致（不重置）

**Debugger 异常处理**
- [ ] 目标 Tab 已打开 DevTools 时按快捷键，attach 失败，弹窗显示具体错误原因，扩展不崩溃
- [ ] `CAPTURING` 期间手动打开 DevTools，扩展自动回退到 `UNARMED`，弹窗显示"调试器被外部断开"提示

---

## 阶段三：端到端集成测试

**基础链路**
- [ ] 启动 MCP Server → 加载扩展 → 扩展连接成功
- [ ] 调用 `prepare_capture_session`（target=`https://example.com`, types=`["network","console"]`, action_mode=`manual`）
- [ ] 扩展收到配置进入 `ARMED` 态
- [ ] 打开 `https://example.com`，按 `Alt+Shift+C` 开始录制
- [ ] 页面上触发几个请求（刷新、点击等）
- [ ] 再次按 `Alt+Shift+C` 停止，MCP Server 收到数据并写入 `latest_trace.json`
- [ ] 调用 `analyze_capture_results`，返回包含 `network_logs` 和 `console_logs` 的 JSON

**`action_mode: reload` 链路**
- [ ] 调用 `prepare_capture_session`（action_mode=`reload`）
- [ ] 按快捷键后，目标 Tab 自动刷新，能捕获到页面完整加载的网络请求

**数据完整性验证**
- [ ] `network_logs` 中每条记录包含：`url` `method` `status` `durationMs` `type`
- [ ] `console_logs` 中每条记录包含：`level` `source` `text` `timestamp`
- [ ] 捕获期间未完成的请求以 `status: null` 出现在结果中

---

## 阶段四：脱敏验证

- [ ] 请求头含 `Authorization: Bearer TOKEN123`，结果中显示 `Bearer [MASKED]`
- [ ] 请求头含 `Cookie: session=abc`，结果中显示 `[MASKED]`
- [ ] 响应头含 `Set-Cookie`，结果中值被替换
- [ ] Console 日志文本中含 `Authorization: Bearer xxx`，上报后 token 被遮蔽
- [ ] 普通请求头（如 `Content-Type`）不被误替换

---

## 阶段五：健壮性测试

- [ ] WS 发送超大 JSON（> 1MB），Server 正常写入不崩溃
- [ ] 快速连续按两次快捷键（双击），不产生状态错乱
- [ ] 关闭正在捕获的 Tab，`onDetach` 触发，状态自动回退到 `UNARMED`
- [ ] 先 `cleanup`，再 `cleanup`，第二次返回"已干净"而非报错
