/**
 * chrome-devtools-capturer MCP Server
 *
 * 架构概览：
 * ┌─────────────────┐   stdio (MCP协议)   ┌──────────────────────┐
 * │  Claude / LLM   │ ◄──────────────────► │   本文件 (MCP Server) │
 * └─────────────────┘                      └──────────┬───────────┘
 *                                                     │ WebSocket (ws://localhost:6666)
 *                                          ┌──────────▼───────────┐
 *                                          │   Chrome 扩展 (客户端) │
 *                                          └──────────────────────┘
 *
 * 工作流程：
 * 1. Claude 调用 prepare_capture_session  → Server 通过 WS 下发配置给扩展
 * 2. 扩展根据配置捕获 DevTools 数据       → 完成后通过 WS 上报 JSON 结果
 * 3. Server 将结果写入 latest_trace.json  → 供 Claude 读取分析
 * 4. Claude 调用 analyze_capture_results  → Server 返回文件内容供分析
 * 5. Claude 调用 cleanup_vibe_workspace   → Server 删除文件，防止上下文污染
 */

// ── 依赖导入 ────────────────────────────────────────────────────────────────

/**
 * McpServer: MCP SDK 核心类，管理 Tool 注册与 JSON-RPC 请求路由。
 * StdioServerTransport: 基于标准 I/O 的传输层。
 *   Claude Desktop / claude-code 通过子进程的 stdin/stdout 与本 Server 通信，
 *   因此所有业务日志必须写 stderr，不能污染 stdout 的 JSON-RPC 通道。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/**
 * z (Zod): MCP SDK 内部用 Zod 做参数校验与 JSON Schema 生成。
 *   注册 Tool 时传入 Zod Schema，SDK 自动将参数结构暴露给 LLM。
 */
import { z } from "zod";

/**
 * WebSocketServer: 与 Chrome 扩展实时双向通信。
 *   选择 WebSocket 而非 HTTP 的原因：支持服务端主动推送（Server → 扩展方向）。
 */
import { WebSocketServer } from "ws";

/**
 * fs / path / url: Node.js 内置模块。
 *   fs:   同步读写 .vibeDevtools/latest_trace.json。
 *   path: 跨平台路径拼接。
 *   url:  ESM 模块下通过 import.meta.url 还原 __dirname（CJS 已内置，ESM 需手动处理）。
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ── 路径初始化 ──────────────────────────────────────────────────────────────

/**
 * ESM 模块中没有原生 __dirname，从 import.meta.url 手动还原。
 * import.meta.url 示例：file:///c/code/chrome-devtools-capturer/mcp-server/index.js
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 工作区目录放在项目根目录（mcp-server 的上一级），便于未来 Chrome 扩展子项目共享访问。
 *
 * 目录结构示意：
 *   chrome-devtools-capturer/       ← 项目根（__dirname/../）
 *   ├── mcp-server/
 *   │   └── index.js               ← 本文件（__dirname）
 *   └── .vibeDevtools/             ← WORKSPACE_DIR（运行时自动创建）
 *       └── latest_trace.json      ← TRACE_FILE（扩展上报后写入）
 */
const WORKSPACE_DIR = path.resolve(__dirname, "..", ".vibeDevtools");
const TRACE_FILE = path.join(WORKSPACE_DIR, "latest_trace.json");

/**
 * 首次运行时目录可能不存在，提前创建避免后续写文件报错。
 * recursive: true 等同于 mkdir -p，父目录不存在时一并创建。
 */
if (!fs.existsSync(WORKSPACE_DIR)) {
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
}

// ── WebSocket Server ────────────────────────────────────────────────────────

const WS_PORT = 8765;

/**
 * 创建 WebSocket 服务端，等待 Chrome 扩展通过 new WebSocket("ws://localhost:6666") 连接。
 * 此 Server 与 MCP stdio 传输完全独立，互不干扰。
 * wss.clients 会自动维护所有活跃连接的集合，供 broadcast() 遍历。
 */
const wss = new WebSocketServer({ port: WS_PORT });

wss.on("listening", () => {
  process.stderr.write(`[WS] WebSocket server listening on ws://localhost:${WS_PORT}\n`);
});

/**
 * 每当 Chrome 扩展建立新连接时触发。
 * ws 参数代表该客户端的独立连接对象，所有收发消息均通过它操作。
 */
wss.on("connection", (ws) => {
  process.stderr.write("[WS] Chrome extension connected\n");

  /**
   * 监听扩展上报的捕获结果。
   *
   * 数据流向：Chrome 扩展 → WebSocket → Server → latest_trace.json
   *
   * 约定：扩展发送的消息必须是合法 JSON 字符串，结构由扩展侧定义。
   * Server 不做业务校验，只负责格式化落盘，供 Claude 后续读取分析。
   */
  ws.on("message", (raw) => {
    try {
      // 解析后重新序列化（2空格缩进），便于人工检查和 Claude 解析
      const parsed = JSON.parse(raw.toString());
      const formatted = JSON.stringify(parsed, null, 2);

      // writeFileSync（同步写）确保写完再处理下一条，避免并发覆盖竞态
      fs.writeFileSync(TRACE_FILE, formatted, "utf-8");
      process.stderr.write(`[WS] Trace data written to ${TRACE_FILE}\n`);
    } catch (err) {
      // JSON 解析失败或写入失败时记录错误，不关闭连接，扩展可继续重试
      process.stderr.write(`[WS] Failed to parse/write message: ${err.message}\n`);
    }
  });

  ws.on("close", () => {
    process.stderr.write("[WS] Chrome extension disconnected\n");
  });

  ws.on("error", (err) => {
    process.stderr.write(`[WS] Socket error: ${err.message}\n`);
  });
});

/**
 * 向所有处于 OPEN 状态的 WebSocket 客户端广播消息。
 *
 * 数据流向：MCP Tool 调用 → broadcast() → Chrome 扩展
 *
 * @param {object} payload - 要发送的 JSON 对象（内部序列化为字符串）
 * @returns {number} 实际发送成功的客户端数量（0 表示当前无扩展连接）
 */
function broadcast(payload) {
  const message = JSON.stringify(payload);
  let count = 0;
  for (const client of wss.clients) {
    // 只向已建立连接的客户端发送，跳过正在握手或已关闭的连接
    if (client.readyState === client.OPEN) {
      client.send(message);
      count++;
    }
  }
  return count;
}

// ── MCP Server ──────────────────────────────────────────────────────────────

/**
 * 创建 MCP Server 实例。
 * name / version 在 MCP 握手阶段暴露给客户端，用于标识本 Server。
 */
const server = new McpServer({
  name: "chrome-devtools-capturer",
  version: "1.0.0",
});

// ── Tool 1: prepare_capture_session ────────────────────────────────────────

/**
 * 将捕获配置下发给 Chrome 扩展，通知扩展开始按配置捕获 DevTools 数据。
 *
 * 典型调用场景：
 *   Claude: "请捕获 https://example.com 的网络请求和控制台日志"
 *   → Claude 解析意图后调用本 Tool
 *   → Server 通过 WS 广播给扩展
 *   → 扩展激活监听器并开始采集
 *
 * 参数说明：
 *   target      : 目标页面 URL 或标识符，扩展用于过滤/定位目标 Tab
 *   types       : 捕获的数据类型数组，例如 ['network', 'console', 'performance']
 *   action_mode : 捕获触发模式，例如 'auto'（自动）| 'manual'（手动）| 'record'（录制）
 */
server.tool(
  "prepare_capture_session",
  "Push capture configuration to the Chrome extension and start a capture session",
  {
    target: z.string().describe("The URL or page identifier to capture"),
    types: z
      .array(z.string())
      .describe("DevTools data types to capture, e.g. ['network', 'console', 'performance']"),
    action_mode: z
      .string()
      .describe("Capture action mode: 'auto' | 'manual' | 'record'"),
  },
  async ({ target, types, action_mode }) => {
    const payload = { target, types, action_mode };
    const sentTo = broadcast(payload);

    // 无扩展连接时明确告知，避免 Claude 误以为任务已成功下发
    if (sentTo === 0) {
      return {
        content: [
          {
            type: "text",
            text: [
              "⚠️  配置已准备就绪，但当前没有 Chrome 扩展连接到 WebSocket 服务 (ws://localhost:6666)。",
              "",
              "请确认扩展已安装并处于激活状态，然后重试。",
            ].join("\n"),
          },
        ],
      };
    }

    // 成功时返回人类可读的确认文案，引导用户去浏览器完成操作
    return {
      content: [
        {
          type: "text",
          text: [
            `✅ 捕获会话已成功启动，配置已下发给 ${sentTo} 个扩展实例。`,
            "",
            "```json",
            JSON.stringify(payload, null, 2),
            "```",
            "",
            "**接下来请在浏览器中操作：**",
            `1. 打开目标页面：${target}`,
            "2. 执行你想要捕获的用户行为或触发目标请求。",
            "3. 操作完成后，回到此处调用 `analyze_capture_results` 读取捕获结果。",
          ].join("\n"),
        },
      ],
    };
  }
);

// ── Tool 2: analyze_capture_results ────────────────────────────────────────

/**
 * 读取扩展上报并落盘的捕获结果，以文本形式返回给 Claude 分析。
 *
 * 典型调用场景：
 *   Claude: "请分析刚才捕获的网络请求，找出耗时超过 1s 的接口"
 *   → Claude 调用本 Tool 获取原始数据，在上下文中直接分析
 *
 * 分析完成后，建议调用 cleanup_vibe_workspace 清理文件，防止旧数据污染后续对话。
 */
server.tool(
  "analyze_capture_results",
  "Read the latest captured DevTools trace written by the Chrome extension",
  {}, // 无参数，始终读取最新的一份 trace 文件
  async () => {
    if (!fs.existsSync(TRACE_FILE)) {
      return {
        content: [
          {
            type: "text",
            text: [
              "⚠️  暂无捕获数据。`.vibeDevtools/latest_trace.json` 文件不存在。",
              "",
              "请先调用 `prepare_capture_session`，在浏览器中完成操作后再读取结果。",
            ].join("\n"),
          },
        ],
      };
    }

    try {
      const content = fs.readFileSync(TRACE_FILE, "utf-8");
      return {
        content: [{ type: "text", text: content }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `❌ 读取 trace 文件失败：${err.message}`,
          },
        ],
      };
    }
  }
);

// ── Tool 3: cleanup_vibe_workspace ─────────────────────────────────────────

/**
 * 删除 latest_trace.json，实现"阅后即焚"。
 *
 * 设计动机：
 *   捕获结果可能包含大量 JSON 数据（网络请求、日志等），若不清理，
 *   Claude 在后续对话中再次调用 analyze_capture_results 会读取到旧数据，
 *   导致上下文混淆或 Token 浪费。
 *
 * 建议工作流：
 *   prepare_capture_session → （浏览器操作）→ analyze_capture_results → cleanup_vibe_workspace
 *
 * 注意：本 Tool 只删除 latest_trace.json，不删除 .vibeDevtools 目录本身，
 *       保留目录结构以备下一轮捕获使用。
 */
server.tool(
  "cleanup_vibe_workspace",
  "Delete the latest trace file to prevent stale data from polluting future LLM context",
  {}, // 无参数，操作目标固定为 latest_trace.json
  async () => {
    if (!fs.existsSync(TRACE_FILE)) {
      return {
        content: [
          {
            type: "text",
            text: "ℹ️  工作区已经是干净状态，`.vibeDevtools/latest_trace.json` 文件不存在，无需清理。",
          },
        ],
      };
    }

    try {
      fs.unlinkSync(TRACE_FILE);
      process.stderr.write(`[Cleanup] Deleted ${TRACE_FILE}\n`);
      return {
        content: [
          {
            type: "text",
            text: "🗑️  清理完成。`latest_trace.json` 已删除，工作区已恢复干净状态，可以开始新一轮捕获。",
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `❌ 删除文件失败：${err.message}`,
          },
        ],
      };
    }
  }
);

// ── 启动 MCP 传输层 ─────────────────────────────────────────────────────────

/**
 * StdioServerTransport 将本进程的 stdin/stdout 作为 MCP 通信信道。
 * Claude Desktop / claude-code 通过子进程的 stdin 发送 JSON-RPC 请求，
 * 从 stdout 读取响应。server.connect() 完成 MCP 握手后开始监听 Tool 调用。
 */
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("[MCP] Server connected via stdio transport\n");
