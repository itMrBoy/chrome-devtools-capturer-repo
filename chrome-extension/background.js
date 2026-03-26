/**
 * chrome-devtools-capturer — Background Service Worker (Manifest V3)
 *
 * 状态机流转：
 *
 *   ┌──────────┐   WS 收到配置    ┌─────────┐   快捷键(首次)   ┌────────────┐
 *   │ UNARMED  │ ───────────────► │  ARMED  │ ───────────────► │ CAPTURING  │
 *   └──────────┘                  └─────────┘                  └─────┬──────┘
 *        ▲                                                            │
 *        └────────────────────────────────────────────────────────────┘
 *                             快捷键(再次) → detach + 上报真实数据
 *
 * CDP 数据流：
 *   attach → Network.enable + Log.enable
 *         → onEvent: Network.requestWillBeSent  → requestMap[id] 存入请求基础信息
 *         → onEvent: Network.responseReceived   → 与 requestMap 合并，推入 network_logs
 *         → onEvent: Log.entryAdded             → 推入 console_logs
 *   detach → 打包 network_logs + console_logs → wsSend
 */

// ── 常量 ────────────────────────────────────────────────────────────────────

const WS_URL        = "ws://localhost:8765";
const WS_RETRY_BASE = 1000;   // 初始重连间隔 1s
const WS_RETRY_MAX  = 30000;  // 最大重连间隔 30s
const DEBUGGER_VER  = "1.3";  // CDP 协议版本

// ── 扩展状态 ─────────────────────────────────────────────────────────────────

/**
 * 扩展运行时全局状态。
 * Service Worker 可能被浏览器随时挂起/唤醒，activeTabId 是恢复现场的关键字段。
 */
const state = {
  /** @type {"UNARMED" | "ARMED" | "CAPTURING"} */
  phase: "UNARMED",

  /** 从 WS 服务端接收到的完整配置对象 */
  config: null,

  /** 当前正在调试的 Tab ID，CAPTURING 阶段有效 */
  activeTabId: null,

  /** WS 是否处于连接状态，供 popup 渲染用 */
  wsConnected: false,

  /**
   * 最近一次面向用户的即时状态消息。
   * popup 打开时会拉取此字段，显示最新的操作结果或错误原因。
   */
  statusMessage: "等待 MCP Server 下发配置...",
};

// ── 状态广播 ─────────────────────────────────────────────────────────────────

/**
 * 将当前 state 快照广播给 popup（若已打开）。
 * popup 通过 chrome.runtime.onMessage 接收 STATE_UPDATE 消息并实时刷新 UI。
 *
 * sendMessage 在 popup 未打开时会触发 lastError（"Could not establish connection"），
 * 这是正常情况，忽略即可，不能 throw。
 */
function broadcastState() {
  chrome.runtime.sendMessage(
    { type: "STATE_UPDATE", state: getStateSnapshot() },
    () => void chrome.runtime.lastError  // 消费 lastError，避免 Chrome 打印警告
  );
}

/** 返回供 popup 使用的状态快照（仅暴露必要字段） */
function getStateSnapshot() {
  return {
    phase:         state.phase,
    wsConnected:   state.wsConnected,
    config:        state.config,
    statusMessage: state.statusMessage,
  };
}

// ── 采集缓冲区 ───────────────────────────────────────────────────────────────

/**
 * 一次 CAPTURING 会话期间的数据缓冲区，detach 时打包发送后清空。
 *
 * requestMap: 以 requestId 为键，暂存 requestWillBeSent 的数据，
 *             等 responseReceived 到来后合并为完整 network_log 条目。
 *             CDP 的请求/响应事件是异步分离的，必须靠 requestId 关联。
 */
const capture = {
  /** @type {Map<string, object>}  key = CDP requestId */
  requestMap:   new Map(),

  /** @type {Array<object>}  已完成（拿到响应）的网络请求精简记录 */
  network_logs: [],

  /** @type {Array<object>}  Log.entryAdded 收集的控制台条目 */
  console_logs: [],
};

/** 重置缓冲区，供每次新会话开始时调用 */
function resetCapture() {
  capture.requestMap.clear();
  capture.network_logs = [];
  capture.console_logs = [];
}

// ── 脱敏拦截器 ───────────────────────────────────────────────────────────────

/**
 * 对字符串进行基础脱敏处理。
 *
 * 覆盖场景：
 *   - HTTP 请求头 Authorization: Bearer <token>  → Authorization: Bearer [MASKED]
 *   - HTTP 请求头 Cookie: <value>                → Cookie: [MASKED]
 *
 * 设计说明：
 *   - 使用正则 + 全局替换（g flag），覆盖同一字符串中多处出现的情况。
 *   - 大小写不敏感（i flag），兼容 Authorization / authorization 等写法。
 *   - 仅替换"值"部分，保留键名，便于后续判断头是否存在。
 *
 * @param {string} text
 * @returns {string}
 */
function maskSensitive(text) {
  if (typeof text !== "string") return text;

  return text
    // Authorization: Bearer eyJhbGci...  →  Authorization: Bearer [MASKED]
    // 也兼容 Token / Basic 等其他 scheme
    .replace(/(Authorization\s*:\s*\S+\s+)\S+/gi, "$1[MASKED]")
    // Cookie: session=abc; token=xyz  →  Cookie: [MASKED]
    .replace(/(Cookie\s*:\s*).+/gi, "$1[MASKED]");
}

/**
 * 对 CDP headers 对象（{ headerName: headerValue }）逐字段脱敏。
 *
 * @param {Record<string, string> | undefined} headers
 * @returns {Record<string, string>}
 */
function maskHeaders(headers) {
  if (!headers) return {};
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    // 对键名敏感的头直接替换值，其余字段走通用 maskSensitive
    const lowerKey = key.toLowerCase();
    if (lowerKey === "authorization" || lowerKey === "cookie") {
      result[key] = "[MASKED]";
    } else {
      result[key] = maskSensitive(value);
    }
  }
  return result;
}

// ── WebSocket 客户端 ─────────────────────────────────────────────────────────

let ws = null;
let wsRetryDelay = WS_RETRY_BASE;
let wsRetryTimer = null;

/**
 * 建立 WebSocket 连接并绑定所有事件处理器。
 * 每次（重）连接都创建新的 WebSocket 实例。
 */
function connectWS() {
  if (wsRetryTimer) {
    clearTimeout(wsRetryTimer);
    wsRetryTimer = null;
  }

  console.log(`[WS] Connecting to ${WS_URL}...`);
  ws = new WebSocket(WS_URL);

  ws.addEventListener("open", () => {
    console.log("[WS] Connected");
    wsRetryDelay        = WS_RETRY_BASE;
    state.wsConnected   = true;
    state.statusMessage = "MCP Server 已连接，等待下发配置...";
    broadcastState();
  });

  /**
   * 接收 MCP Server 下发的捕获配置，切换为武装态。
   *
   * 期望格式：
   * { target: string, types: string[], action_mode: "reload" | "manual" | "record" }
   */
  ws.addEventListener("message", (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      console.warn("[WS] Non-JSON message ignored:", event.data);
      return;
    }
    console.log("[WS] Config received →", payload);
    state.config        = payload;
    state.phase         = "ARMED";
    state.statusMessage = `配置已就绪，目标：${payload.target ?? "未指定"}。点击"开始录制"或按快捷键启动。`;
    updateBadge("ARMED");
    broadcastState();
  });

  ws.addEventListener("close", (event) => {
    console.warn(`[WS] Disconnected (code=${event.code}). Retry in ${wsRetryDelay}ms...`);
    state.wsConnected   = false;
    state.statusMessage = `MCP Server 连接断开，${wsRetryDelay / 1000}s 后重连...`;
    broadcastState();
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    // error 事件后必跟 close，重连逻辑在 close 处理
  });
}

function scheduleReconnect() {
  wsRetryTimer = setTimeout(() => {
    wsRetryDelay = Math.min(wsRetryDelay * 2, WS_RETRY_MAX);
    connectWS();
  }, wsRetryDelay);
}

/**
 * 安全发送 JSON 对象，连接未就绪时返回 false。
 *
 * @param {object} data
 * @returns {boolean}
 */
function wsSend(data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn("[WS] Cannot send, connection not open");
    return false;
  }
  ws.send(JSON.stringify(data));
  return true;
}

// ── 状态徽标 ─────────────────────────────────────────────────────────────────

function updateBadge(phase) {
  const MAP = {
    UNARMED:   { text: "",    color: "#6b7280" },
    ARMED:     { text: "RDY", color: "#f59e0b" },
    CAPTURING: { text: "REC", color: "#ef4444" },
  };
  const { text, color } = MAP[phase] ?? MAP.UNARMED;
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setTitle({ title: `DevTools Capturer (${phase})` });
}

// ── CDP 命令封装 ─────────────────────────────────────────────────────────────

/**
 * chrome.debugger.sendCommand 的 Promise 封装。
 *
 * @param {number}  tabId
 * @param {string}  method   CDP 方法名，例如 "Network.enable"
 * @param {object}  [params] CDP 方法参数
 * @returns {Promise<object>} CDP 响应 result 对象
 */
function cdpSend(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(`CDP ${method} failed: ${chrome.runtime.lastError.message}`));
      } else {
        resolve(result ?? {});
      }
    });
  });
}

// ── Debugger 操作 ────────────────────────────────────────────────────────────

/**
 * attach debugger 并开启 Network / Log 两个 CDP 域。
 *
 * 成功后 chrome.debugger.onEvent 就会开始收到对应事件，
 * 无需返回任何 "监听句柄"，事件由全局 onEvent listener 统一处理。
 *
 * @param {number} tabId
 * @param {object} config
 */
async function attachDebugger(tabId, config) {
  // 1. attach
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, DEBUGGER_VER, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
  console.log(`[Debugger] Attached to tab ${tabId}`);

  // 2. 开启 Network 域
  //    maxTotalBufferSize / maxResourceBufferSize 单位 bytes，设为 0 表示不限制
  await cdpSend(tabId, "Network.enable", {
    maxTotalBufferSize:    10 * 1024 * 1024,  // 10 MB，防止内存暴涨
    maxResourceBufferSize: 5  * 1024 * 1024,
  });
  console.log("[CDP] Network.enable sent");

  // 3. 开启 Log 域（捕获页面级 console 输出及 JS 异常）
  await cdpSend(tabId, "Log.enable");
  console.log("[CDP] Log.enable sent");

  // 4. 按配置决定是否刷新页面，以便从 navigationStart 起完整捕获
  if (config?.action_mode === "reload") {
    chrome.tabs.reload(tabId, {}, () => {
      if (chrome.runtime.lastError) {
        console.warn("[Tabs] Reload failed:", chrome.runtime.lastError.message);
      } else {
        console.log(`[Tabs] Tab ${tabId} reloaded`);
      }
    });
  }
}

/**
 * detach debugger（幂等：Tab 已关闭或调试器已断开时只记 warn）。
 *
 * @param {number} tabId
 */
async function detachDebugger(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      if (chrome.runtime.lastError) {
        console.warn(`[Debugger] Detach warning (tab ${tabId}):`, chrome.runtime.lastError.message);
      } else {
        console.log(`[Debugger] Detached from tab ${tabId}`);
      }
      resolve();
    });
  });
}

// ── CDP 事件监听 ─────────────────────────────────────────────────────────────

/**
 * 全局 CDP 事件入口，所有 attach 的 Tab 的事件都汇聚于此。
 *
 * 通过 source.tabId 过滤，只处理当前 CAPTURING 会话的 Tab，
 * 避免多 Tab 场景下数据交叉污染。
 */
chrome.debugger.onEvent.addListener((source, method, params) => {
  // 只处理当前捕获会话的 Tab
  if (source.tabId !== state.activeTabId) return;

  switch (method) {

    // ── Network.requestWillBeSent ─────────────────────────────────────────
    // 在浏览器即将发出请求时触发，此时尚无响应状态码。
    // 将基础信息暂存到 requestMap，等待 responseReceived 来补全。
    case "Network.requestWillBeSent": {
      const { requestId, request, timestamp, type } = params;

      capture.requestMap.set(requestId, {
        requestId,
        url:       maskSensitive(request.url),
        method:    request.method,
        // 请求头脱敏：过滤 Authorization / Cookie
        headers:   maskHeaders(request.headers),
        // CDP timestamp 单位为秒（浮点），转为毫秒整数便于阅读
        startTime: Math.round(timestamp * 1000),
        type:      type ?? "Other",   // Document / XHR / Fetch / Script / ...
      });
      break;
    }

    // ── Network.responseReceived ──────────────────────────────────────────
    // 收到响应头时触发（响应体可能还在传输中）。
    // 与 requestMap 中的请求记录合并，计算耗时后推入 network_logs。
    case "Network.responseReceived": {
      const { requestId, response, timestamp } = params;
      const pending = capture.requestMap.get(requestId);

      if (!pending) {
        // 扩展 attach 之前已发出的请求，正常情况，静默跳过
        break;
      }

      const durationMs = Math.round(timestamp * 1000) - pending.startTime;

      capture.network_logs.push({
        requestId:    pending.requestId,
        url:          pending.url,
        method:       pending.method,
        type:         pending.type,
        status:       response.status,
        statusText:   response.statusText,
        mimeType:     response.mimeType,
        // 响应头同样需要脱敏（Set-Cookie 等）
        headers:      maskHeaders(response.headers),
        startTime:    pending.startTime,
        durationMs,   // 从发出请求到响应头到达的耗时（不含响应体下载）
      });

      // 请求已完整记录，从暂存 Map 中移除，释放内存
      capture.requestMap.delete(requestId);
      break;
    }

    // ── Log.entryAdded ────────────────────────────────────────────────────
    // 页面调用 console.xxx / JS 运行时错误 / 网络错误均会触发此事件。
    // 注意：这是 Log 域的聚合事件，比 Runtime.consoleAPICalled 信息更全。
    case "Log.entryAdded": {
      const { entry } = params;
      // entry 结构：{ source, level, text, timestamp, url, lineNumber, stackTrace }

      capture.console_logs.push({
        level:      entry.level,          // "verbose" | "info" | "warning" | "error"
        source:     entry.source,         // "javascript" | "network" | "console-api" | ...
        // 日志文本中可能包含敏感 token（如 fetch 错误消息中打印了完整 URL + Auth）
        text:       maskSensitive(entry.text),
        url:        entry.url   ?? null,  // 触发日志的脚本 URL
        line:       entry.lineNumber ?? null,
        // CDP timestamp 同样是秒级浮点，转为 ISO 字符串便于阅读
        timestamp:  new Date(entry.timestamp * 1000).toISOString(),
      });
      break;
    }

    default:
      // 其他未关注的 CDP 事件，静默忽略
      break;
  }
});

// ── 快捷键处理 ───────────────────────────────────────────────────────────────

/**
 * 快捷键 Alt+Shift+C 的核心逻辑（状态机驱动）。
 *
 * ARMED     → 首次按下：reset 缓冲区 → attach + enable CDP 域 → CAPTURING
 * CAPTURING → 再次按下：detach → 打包真实数据 → wsSend → UNARMED
 * UNARMED   → 按下：提示等待服务端配置
 */
async function handleToggleCapture() {
  console.log(`[Command] toggle-capture triggered, phase=${state.phase}`);

  // ── 情况 1：ARMED → 开始捕获 ───────────────────────────────────────────
  if (state.phase === "ARMED") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      console.error("[Command] No active tab found");
      return;
    }

    try {
      resetCapture();                             // 清空上一轮残留数据
      await attachDebugger(tab.id, state.config); // attach + Network.enable + Log.enable
      state.phase         = "CAPTURING";
      state.activeTabId   = tab.id;
      state.statusMessage = "录制中，请在页面上执行目标操作，完成后再次点击停止。";
      updateBadge("CAPTURING");
      broadcastState();
      console.log(`[State] → CAPTURING (tab=${tab.id})`);
    } catch (err) {
      console.error("[Command] Failed to start capture:", err.message);
      state.statusMessage = `启动失败：${err.message}`;
      broadcastState();
      chrome.action.setTitle({ title: `DevTools Capturer — Error: ${err.message}` });
    }
    return;
  }

  // ── 情况 2：CAPTURING → 停止捕获并上报 ────────────────────────────────
  if (state.phase === "CAPTURING") {
    const tabId  = state.activeTabId;
    const config = state.config;

    // 先 detach，停止 CDP 事件流，确保之后不再有新事件进入缓冲区
    await detachDebugger(tabId);

    // 将仍在 requestMap 中（已有请求但未收到响应）的条目也纳入结果，
    // 标记为 status: null，表示请求在捕获结束时尚未完成
    for (const [, pending] of capture.requestMap) {
      capture.network_logs.push({
        ...pending,
        status:     null,
        statusText: "No response received",
        mimeType:   null,
        headers:    pending.headers,  // 已在 requestWillBeSent 时脱敏
        durationMs: null,
      });
    }

    // 打包完整 trace 对象并通过 WS 发送给 MCP Server
    const trace = {
      meta: {
        capturedAt: new Date().toISOString(),
        tabId,
        config,
        source: "chrome-devtools-capturer-extension",
        stats: {
          network_count: capture.network_logs.length,
          console_count: capture.console_logs.length,
        },
      },
      network_logs: capture.network_logs,
      console_logs: capture.console_logs,
    };

    const sent = wsSend(trace);
    const summary = `已上报 ${trace.meta.stats.network_count} 条网络请求、${trace.meta.stats.console_count} 条日志。`;
    console.log(`[Command] Trace sent via WS: ${sent}, network=${capture.network_logs.length}, console=${capture.console_logs.length}`);

    // 清空状态
    resetCapture();
    state.phase         = "UNARMED";
    state.config        = null;
    state.activeTabId   = null;
    state.statusMessage = sent
      ? `✅ 数据已发送！${summary}请在 Claude 对话中调用 analyze_capture_results 查看分析。`
      : `⚠️ WS 未连接，数据未能发送。请重启 MCP Server 后重试。`;
    updateBadge("UNARMED");
    broadcastState();
    console.log("[State] → UNARMED");
    return;
  }

  // ── 情况 3：UNARMED → 提示等待配置 ────────────────────────────────────
  console.log("[Command] Not armed. Waiting for config from MCP Server...");
  state.statusMessage = "尚未收到配置，请先在 Claude 对话中调用 prepare_capture_session 工具。";
  broadcastState();
  chrome.action.setTitle({ title: "DevTools Capturer — Waiting for MCP config..." });
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-capture") {
    handleToggleCapture().catch((err) => {
      console.error("[Command] Unhandled error:", err);
    });
  }
});

// ── 调试器异常断开监听 ───────────────────────────────────────────────────────

/**
 * 调试器被外部强制断开（如用户打开 DevTools 抢占连接）时重置状态。
 * 此时缓冲区数据丢弃，避免下一轮捕获时数据污染。
 */
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === state.activeTabId) {
    console.warn(`[Debugger] Externally detached (tab=${source.tabId}, reason=${reason})`);
    resetCapture();
    state.phase         = "UNARMED";
    state.config        = null;
    state.activeTabId   = null;
    state.statusMessage = `调试器被外部断开（原因：${reason}），请重新调用 prepare_capture_session 配置后再录制。`;
    updateBadge("UNARMED");
    broadcastState();
    chrome.action.setTitle({ title: "DevTools Capturer — Detached externally, please re-arm" });
  }
});

// ── Popup 消息处理 ───────────────────────────────────────────────────────────

/**
 * 处理来自 popup.js 的消息请求。
 *
 * GET_STATE     → 返回当前状态快照（popup 打开时初始化用）
 * TOGGLE_CAPTURE → 执行与快捷键相同的逻辑，返回执行后的新状态快照
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "GET_STATE") {
    sendResponse(getStateSnapshot());
    return false; // 同步响应，无需保持通道
  }

  if (msg.type === "TOGGLE_CAPTURE") {
    // handleToggleCapture 是 async，需要返回 true 保持消息通道开放，
    // 等 Promise resolve 后再 sendResponse
    handleToggleCapture()
      .catch((err) => console.error("[BG] TOGGLE_CAPTURE error:", err))
      .finally(() => sendResponse(getStateSnapshot()));
    return true; // 异步响应
  }
});

// ── 初始化 ───────────────────────────────────────────────────────────────────

console.log("[BG] Service worker started");
updateBadge("UNARMED");
connectWS();
