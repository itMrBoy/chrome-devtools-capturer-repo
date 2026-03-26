/**
 * popup.js — 扩展弹窗交互层
 *
 * 职责：
 * 1. 打开时向 background 查询当前状态并渲染 UI
 * 2. 按钮点击 → 向 background 发送 TOGGLE_CAPTURE 消息
 * 3. 监听 background 主动推送的 STATE_UPDATE，实时刷新 UI（无需轮询）
 */

// ── DOM 引用 ─────────────────────────────────────────────────────────────────

const phaseDot   = document.getElementById("phaseDot");
const phaseLabel = document.getElementById("phaseLabel");
const wsDot      = document.getElementById("wsDot");
const wsLabel    = document.getElementById("wsLabel");
const statusMsg  = document.getElementById("statusMsg");
const statusHint = document.getElementById("statusHint");
const actionBtn  = document.getElementById("actionBtn");

// ── 状态渲染 ─────────────────────────────────────────────────────────────────

/**
 * 各状态对应的 UI 配置：
 *   msg      弹窗主提示文案
 *   hint     次级提示（灰色小字）
 *   btnText  按钮文案
 *   btnClass 按钮样式
 *   btnDisabled 是否禁用
 */
const PHASE_UI = {
  UNARMED: {
    msg:         "等待 MCP Server 下发捕获配置。",
    hint:        "请先在 Claude 对话中调用 prepare_capture_session 工具。",
    btnText:     "— 等待配置 —",
    btnClass:    "btn-waiting",
    btnDisabled: true,
  },
  ARMED: {
    msg:         "配置已就绪，可以开始录制。",
    hint:        "点击下方按钮或按快捷键，然后在页面上执行目标操作。",
    btnText:     "▶ 开始录制",
    btnClass:    "btn-start",
    btnDisabled: false,
  },
  CAPTURING: {
    msg:         "录制中，请在页面上执行目标操作…",
    hint:        "操作完成后点击下方按钮停止，数据将自动发送给 MCP Server。",
    btnText:     "⏹ 停止并上报",
    btnClass:    "btn-stop",
    btnDisabled: false,
  },
};

/**
 * 根据 background 推送的状态对象渲染整个弹窗。
 *
 * @param {{ phase: string, wsConnected: boolean, config: object|null, statusMessage: string }} s
 */
function render(s) {
  const ui = PHASE_UI[s.phase] ?? PHASE_UI.UNARMED;

  // Phase 指示灯
  phaseDot.className  = `phase-dot ${s.phase.toLowerCase()}`;
  phaseLabel.textContent = s.phase;

  // WebSocket 连接状态
  wsDot.className = `ws-dot ${s.wsConnected ? "connected" : ""}`;
  wsLabel.textContent = s.wsConnected
    ? "MCP Server 已连接"
    : "MCP Server 未连接 — 请先启动 node index.js";

  // 状态消息：优先显示 background 传来的即时消息，否则用默认文案
  statusMsg.textContent  = s.statusMessage || ui.msg;
  statusHint.textContent = ui.hint;

  // 若配置包含 target，附加显示目标地址
  if (s.config?.target && s.phase !== "UNARMED") {
    statusHint.textContent += `\n目标：${s.config.target}`;
  }

  // 按钮
  actionBtn.textContent = ui.btnText;
  actionBtn.className   = `btn ${ui.btnClass}`;
  actionBtn.disabled    = ui.btnDisabled;
}

// ── 与 Background 通信 ───────────────────────────────────────────────────────

/**
 * 向 background service worker 发送消息并等待响应。
 * MV3 中 sendMessage 是异步的，用 Promise 封装便于 async/await 使用。
 *
 * @param {object} msg
 * @returns {Promise<object>}
 */
function sendToBackground(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      // 若 background 已挂起或出现错误，lastError 会被设置；忽略即可
      if (chrome.runtime.lastError) {
        console.warn("[Popup] sendMessage error:", chrome.runtime.lastError.message);
        resolve(null);
      } else {
        resolve(response);
      }
    });
  });
}

// 弹窗打开时拉取一次当前状态
(async () => {
  const state = await sendToBackground({ type: "GET_STATE" });
  if (state) render(state);
})();

// 按钮点击 → 触发 toggle（与快捷键等效）
actionBtn.addEventListener("click", async () => {
  actionBtn.disabled = true; // 防止重复点击
  const state = await sendToBackground({ type: "TOGGLE_CAPTURE" });
  if (state) render(state);
});

// ── 实时状态推送 ─────────────────────────────────────────────────────────────

/**
 * 监听 background 主动推送的状态更新。
 * 当 background 中状态发生变化（如 WS 连上、配置下发、录制开始/结束）时，
 * 会调用 broadcastState()，弹窗若处于打开状态则会收到并即时刷新。
 */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "STATE_UPDATE") {
    render(msg.state);
  }
});
