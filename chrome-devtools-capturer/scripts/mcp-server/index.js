/**
 * chrome-devtools-capturer MCP Server
 *
 * 架构概览：
 * ┌─────────────────┐   stdio (MCP协议)   ┌──────────────────────┐
 * │  Claude / LLM   │ ◄──────────────────► │   本文件 (MCP Server) │
 * └─────────────────┘                      └──────────┬───────────┘
 *                                                     │ WebSocket (ws://localhost:8765)
 *                                          ┌──────────▼───────────┐
 *                                          │   Chrome 扩展 (客户端) │
 *                                          └──────────────────────┘
 *
 * 工作流程（流式落盘架构）：
 * 1. Claude 调用 prepare_capture_session  → Server 通过 WS 下发配置给扩展
 * 2. 扩展采集期间流式透传 Tracing 数据     → tracing_chunk 逐条追加写入 raw_trace.jsonl（NDJSON）
 * 3. 扩展停止后发送 tracing_complete       → Server 用 readline 逐行读取 .jsonl → 执行脱水算法
 * 4. 脱水完成后删除 raw_trace.jsonl        → 精简结果合并 capture_result 写入 latest_trace.json
 * 5. Claude 调用 analyze_capture_results  → Server 返回文件内容供分析
 * 6. Claude 调用 cleanup_vibe_workspace   → Server 删除文件，防止上下文污染
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
import readline from "readline";

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
 * 流式落盘的临时 NDJSON 文件（每行一个 JSON 对象）。
 * tracing_chunk 到达时追加写入，tracing_complete 时逐行读取后删除。
 */
const RAW_TRACE_FILE = path.join(WORKSPACE_DIR, "raw_trace.jsonl");

/**
 * 确保 .vibeDevtools 目录存在。
 * recursive: true 等同于 mkdir -p，父目录不存在时一并创建。
 */
function ensureWorkspaceDir() {
  if (!fs.existsSync(WORKSPACE_DIR)) {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  }
}

/**
 * 清空 .vibeDevtools 目录中的所有文件，防止旧数据污染新一轮捕获。
 * 只删除文件，保留目录本身。
 */
function cleanWorkspace() {
  if (fs.existsSync(WORKSPACE_DIR)) {
    for (const file of fs.readdirSync(WORKSPACE_DIR)) {
      const filePath = path.join(WORKSPACE_DIR, file);
      if (fs.statSync(filePath).isFile()) {
        fs.unlinkSync(filePath);
      }
    }
    process.stderr.write(`[Cleanup] Cleared all files in ${WORKSPACE_DIR}\n`);
  }
  // 同时重置 Tracing 落盘状态并清空暂存
  resetTracingState();
  pendingCaptureResult = null;
  ensureWorkspaceDir();
}

// 首次运行时确保目录存在
ensureWorkspaceDir();

// ── Tracing 流式落盘状态 ─────────────────────────────────────────────────

/**
 * 标记当前是否有 Tracing 数据正在流式写入 raw_trace.jsonl。
 * 用于判断 capture_result 到达时是否需要等待 tracing_complete。
 */
let tracingInProgress = false;

/** 重置 Tracing 落盘状态，并删除临时文件（如果存在） */
function resetTracingState() {
  tracingInProgress = false;
  if (fs.existsSync(RAW_TRACE_FILE)) {
    try { fs.unlinkSync(RAW_TRACE_FILE); } catch { /* ignore */ }
  }
}

/**
 * 使用 readline 逐行读取 NDJSON 文件，解析为事件数组。
 * 相比整体读入再 split，对超大文件更友好（GC 压力更分散）。
 *
 * @param {string} filePath  NDJSON 文件路径
 * @returns {Promise<Array<object>>}
 */
function readNDJSON(filePath) {
  return new Promise((resolve, reject) => {
    const events = [];
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try { events.push(JSON.parse(trimmed)); } catch { /* skip malformed lines */ }
    });
    rl.on("close", () => resolve(events));
    rl.on("error", reject);
  });
}

// ── extractLongTasks 脱水算法（从扩展端移植） ──────────────────────────────

/** 长任务阈值：50ms = 50000μs */
const LONG_TASK_THRESHOLD_US = 50000;

/** 具有业务归因意义的事件名集合 */
const SIGNIFICANT_EVENTS = new Set([
  "FunctionCall",
  "EvaluateScript",
  "CompileScript",
  "UpdateLayoutTree",
  "Layout",
  "MinorGC",
  "MajorGC",
  "ParseHTML",
  "Paint",
  "CompositeLayers",
  "RecalculateStyles",
  "TimerFire",
  "XHRReadyStateChange",
  "EventDispatch",
]);

/**
 * 将微秒转换为毫秒，保留一位小数。
 * @param {number} us 微秒值
 * @returns {number}
 */
function usToMs(us) {
  return Math.round(us / 100) / 10;
}

/**
 * 从 args.data 中提取关键归因信息。
 * @param {object} evt trace 事件
 * @returns {object|null}
 */
function extractCallInfo(evt) {
  const data = evt.args?.data;
  if (!data) return null;

  const info = {};
  if (data.url)          info.url          = data.url;
  if (data.functionName) info.functionName = data.functionName;
  if (data.lineNumber != null)   info.lineNumber   = data.lineNumber;
  if (data.columnNumber != null) info.columnNumber  = data.columnNumber;
  if (data.scriptId)    info.scriptId     = data.scriptId;

  return Object.keys(info).length > 0 ? info : null;
}

/**
 * 核心提炼函数：从原始 traceEvents 中提取长任务及其耗时元凶。
 *
 * @param {Array<object>} traceEvents  Tracing.dataCollected 收集的所有事件
 * @returns {{ summary: object, longTasks: Array<object> }}
 */
function extractLongTasks(traceEvents) {
  if (!traceEvents || traceEvents.length === 0) {
    return { summary: { totalLongTasks: 0, totalBlockingTimeMs: 0 }, longTasks: [] };
  }

  // 步骤 A：定位主线程
  let mainPid = null;
  let mainTid = null;

  for (const evt of traceEvents) {
    if (
      evt.cat === "__metadata" &&
      (evt.name === "thread_name") &&
      evt.args?.name &&
      (evt.args.name === "CrRendererMain" || evt.args.name === "CrWorkerMain")
    ) {
      mainPid = evt.pid;
      mainTid = evt.tid;
      break;
    }
  }

  if (mainPid === null || mainTid === null) {
    return {
      summary: { totalLongTasks: 0, totalBlockingTimeMs: 0, note: "Main thread not found in trace" },
      longTasks: [],
    };
  }

  // 预过滤：只保留主线程事件
  const mainThreadEvents = traceEvents.filter(
    (evt) => evt.pid === mainPid && evt.tid === mainTid
  );

  // 步骤 B：筛选顶级长任务
  const longRunTasks = mainThreadEvents.filter(
    (evt) =>
      evt.name === "RunTask" &&
      (evt.ph === "X" || evt.ph === "B") &&
      typeof evt.dur === "number" &&
      evt.dur >= LONG_TASK_THRESHOLD_US
  );

  longRunTasks.sort((a, b) => a.ts - b.ts);

  // 步骤 C + D：下钻归因 + 格式化
  let totalBlockingTimeUs = 0;

  const longTasks = longRunTasks.map((task, index) => {
    const taskStart = task.ts;
    const taskEnd   = task.ts + task.dur;

    const blockingTimeUs = task.dur - LONG_TASK_THRESHOLD_US;
    totalBlockingTimeUs += blockingTimeUs;

    const children = mainThreadEvents.filter((evt) => {
      if (evt === task) return false;
      if (typeof evt.ts !== "number" || typeof evt.dur !== "number") return false;
      return evt.ts >= taskStart && (evt.ts + evt.dur) <= taskEnd;
    });

    const heavySubTasks = children
      .filter((evt) => SIGNIFICANT_EVENTS.has(evt.name))
      .sort((a, b) => b.dur - a.dur)
      .slice(0, 5)
      .map((evt) => {
        const entry = {
          name:       evt.name,
          durationMs: usToMs(evt.dur),
          startMs:    usToMs(evt.ts),
        };
        const callInfo = extractCallInfo(evt);
        if (callInfo) entry.callInfo = callInfo;
        return entry;
      });

    return {
      index:          index + 1,
      startMs:        usToMs(task.ts),
      durationMs:     usToMs(task.dur),
      blockingTimeMs: usToMs(blockingTimeUs),
      heavySubTasks,
    };
  });

  return {
    summary: {
      mainThread:         { pid: mainPid, tid: mainTid },
      totalLongTasks:     longTasks.length,
      totalBlockingTimeMs: usToMs(totalBlockingTimeUs),
    },
    longTasks,
  };
}

/**
 * 暂存的 capture_result 数据（网络/日志），等待 tracing_complete 后合并写入。
 * @type {object|null}
 */
let pendingCaptureResult = null;

// ── WebSocket Server ────────────────────────────────────────────────────────

const WS_PORT = 8765;

/**
 * 创建 WebSocket 服务端，等待 Chrome 扩展通过 new WebSocket("ws://localhost:8765") 连接。
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
   * 监听扩展上报的消息，按类型分流处理：
   *
   * - tracing_chunk:    流式 Tracing 数据块，逐条追加写入 raw_trace.jsonl（NDJSON 格式）
   * - tracing_complete: Tracing 结束信号，从 .jsonl 文件逐行读取 → 脱水算法 → 写入结果 → 删除临时文件
   * - capture_result:   网络/日志数据，暂存等待合并或直接落盘
   * - (无 type):        兼容旧版扩展，直接落盘
   */
  ws.on("message", (raw) => {
    try {
      const parsed = JSON.parse(raw.toString());

      // ── 流式 Tracing 数据块 → 追加写入 NDJSON 文件 ──────────────────
      if (parsed.type === "tracing_chunk") {
        if (Array.isArray(parsed.data)) {
          ensureWorkspaceDir();
          // 将每个事件对象序列化为单独一行，追加写入 .jsonl 文件
          let ndjsonBatch = "";
          for (const evt of parsed.data) {
            ndjsonBatch += JSON.stringify(evt) + "\n";
          }
          fs.appendFileSync(RAW_TRACE_FILE, ndjsonBatch, "utf-8");
          tracingInProgress = true;
        }
        process.stderr.write(`[WS] Tracing chunk appended to ${RAW_TRACE_FILE}\n`);
        return;
      }

      // ── Tracing 结束信号 → 读取 NDJSON → 脱水 → 落盘 → 清理 ───────
      if (parsed.type === "tracing_complete") {
        process.stderr.write(`[WS] Tracing complete signal received, starting dehydration...\n`);

        // 异步处理：读取 NDJSON → extractLongTasks → 写入 latest_trace.json → 删除 .jsonl
        (async () => {
          try {
            if (!fs.existsSync(RAW_TRACE_FILE)) {
              process.stderr.write(`[WS] Warning: ${RAW_TRACE_FILE} not found, skipping dehydration\n`);
              tracingInProgress = false;
              return;
            }

            // 逐行读取 NDJSON 文件
            const traceEvents = await readNDJSON(RAW_TRACE_FILE);
            process.stderr.write(`[Perf] Read ${traceEvents.length} trace events from NDJSON\n`);

            // 执行脱水算法
            const performanceResult = extractLongTasks(traceEvents);
            process.stderr.write(`[Perf] Extracted ${performanceResult.longTasks.length} long tasks, TBT=${performanceResult.summary.totalBlockingTimeMs}ms\n`);

            // 如果已有暂存的 capture_result，合并性能数据后一起写入
            if (pendingCaptureResult) {
              pendingCaptureResult.performance_logs = performanceResult;
              pendingCaptureResult.meta.stats.trace_event_count = traceEvents.length;
              pendingCaptureResult.meta.stats.long_task_count = performanceResult.longTasks.length;

              ensureWorkspaceDir();
              fs.writeFileSync(TRACE_FILE, JSON.stringify(pendingCaptureResult, null, 2), "utf-8");
              process.stderr.write(`[WS] Complete trace (with performance) written to ${TRACE_FILE}\n`);
              pendingCaptureResult = null;
            } else {
              // 性能数据先到，capture_result 尚未到达，单独写入性能结果
              const perfOnly = { performance_logs: performanceResult, meta: { trace_event_count: traceEvents.length } };
              ensureWorkspaceDir();
              fs.writeFileSync(TRACE_FILE, JSON.stringify(perfOnly, null, 2), "utf-8");
              process.stderr.write(`[WS] Performance-only result written to ${TRACE_FILE} (awaiting capture_result)\n`);
            }

            // 清理现场：删除庞大的临时 NDJSON 文件，释放磁盘空间
            fs.unlinkSync(RAW_TRACE_FILE);
            process.stderr.write(`[Cleanup] Deleted temporary file ${RAW_TRACE_FILE}\n`);
            tracingInProgress = false;
          } catch (err) {
            process.stderr.write(`[Perf] Dehydration failed: ${err.message}\n`);
            tracingInProgress = false;
          }
        })();
        return;
      }

      // ── 网络/日志捕获结果 ───────────────────────────────────────────
      if (parsed.type === "capture_result") {
        // 移除 type 字段，不写入文件
        delete parsed.type;

        // 如果已有性能数据（tracing_complete 先到），合并后写入
        if (fs.existsSync(TRACE_FILE)) {
          try {
            const existing = JSON.parse(fs.readFileSync(TRACE_FILE, "utf-8"));
            if (existing.performance_logs) {
              parsed.performance_logs = existing.performance_logs;
              parsed.meta.stats.trace_event_count = existing.meta?.trace_event_count ?? 0;
              parsed.meta.stats.long_task_count = existing.performance_logs.longTasks?.length ?? 0;
            }
          } catch { /* ignore parse errors on existing file */ }
        }

        // 如果 Tracing 数据仍在流式写入中，暂存等待 tracing_complete
        if (tracingInProgress) {
          pendingCaptureResult = parsed;
          process.stderr.write(`[WS] Capture result received, pending tracing_complete to merge\n`);
          return;
        }

        ensureWorkspaceDir();
        fs.writeFileSync(TRACE_FILE, JSON.stringify(parsed, null, 2), "utf-8");
        process.stderr.write(`[WS] Capture result written to ${TRACE_FILE}\n`);
        return;
      }

      // ── 兼容旧版：无 type 字段的消息直接落盘 ──────────────────────
      ensureWorkspaceDir();
      fs.writeFileSync(TRACE_FILE, JSON.stringify(parsed, null, 2), "utf-8");
      process.stderr.write(`[WS] Legacy trace data written to ${TRACE_FILE}\n`);
    } catch (err) {
      process.stderr.write(`[WS] Failed to process message: ${err.message}\n`);
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
    try {
      // 每次新会话前清空旧数据，防止残留的 trace 污染本轮分析
      cleanWorkspace();

      const payload = { target, types, action_mode };
      const sentTo = broadcast(payload);

      // 无扩展连接时明确告知，避免 Claude 误以为任务已成功下发
      if (sentTo === 0) {
        return {
          content: [
            {
              type: "text",
              text: [
                "⚠️  配置已准备就绪，但当前没有 Chrome 扩展连接到 WebSocket 服务 (ws://localhost:8765)。",
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
    } catch (err) {
      return {
        content: [{ type: "text", text: `❌ prepare_capture_session 异常：${err.message}` }],
        isError: true,
      };
    }
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
    try {
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

      const content = fs.readFileSync(TRACE_FILE, "utf-8");
      return {
        content: [{ type: "text", text: content }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `❌ analyze_capture_results 异常：${err.message}` }],
        isError: true,
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
    try {
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
        content: [{ type: "text", text: `❌ cleanup_vibe_workspace 异常：${err.message}` }],
        isError: true,
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
