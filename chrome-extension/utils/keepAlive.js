/**
 * keepAlive.js — Service Worker 保活模块
 *
 * 双层保活策略：
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ WS 已连接：WebSocket keepalive ping（每 20s）                    │
 *   │   → WS 消息收发重置 SW idle timer（Chrome 116+ 原生机制）         │
 *   │   → SW 不会被挂起，WS 连接和内存状态完整保留                       │
 *   ├─────────────────────────────────────────────────────────────────┤
 *   │ WS 已断开：chrome.alarms 低频唤醒（每 30s）                      │
 *   │   → SW 自然休眠以节省资源                                        │
 *   │   → alarm 唤醒后尝试重连，连上后切换为 keepalive 模式              │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * 参考：
 *   - https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets
 *   - https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers
 */

// ── 常量 ────────────────────────────────────────────────────────────────────

/** keepalive ping 间隔，必须 < 30s（SW idle timeout） */
const KEEPALIVE_INTERVAL_MS = 20_000;

/** 重连兜底 alarm 名称（SW 挂起后 setTimeout 会丢失，alarm 不会） */
const RECONNECT_ALARM = "ws-reconnect";

// ── 状态 ────────────────────────────────────────────────────────────────────

let keepAliveTimer = null;

// ── WebSocket Keepalive（WS 连接期间） ──────────────────────────────────────

/**
 * 启动 WebSocket keepalive ping。
 * 每 20s 通过 WS 发送心跳消息，利用 Chrome 116+ 原生机制重置 SW idle timer。
 *
 * @param {WebSocket} ws - 当前活跃的 WebSocket 实例
 */
export function startKeepAlive(ws) {
  stopKeepAlive();
  keepAliveTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "keepalive" }));
    } else {
      // WS 已不可用，停止 keepalive（由 connectWS 的 close handler 触发重连）
      stopKeepAlive();
    }
  }, KEEPALIVE_INTERVAL_MS);
  console.log("[KeepAlive] Started (20s interval)");
}

/**
 * 停止 WebSocket keepalive ping。
 * 在 WS 断开时调用，让 SW 回归自然生命周期管理。
 */
export function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
    console.log("[KeepAlive] Stopped");
  }
}

// ── Chrome Alarms 重连兜底（WS 断开期间） ───────────────────────────────────

/**
 * 调度一次重连 alarm。
 * WS 断开后，setTimeout 用于 SW 存活期间的快速重连；
 * chrome.alarms 作为兜底——SW 被挂起后 setTimeout 会丢失，alarm 不会。
 *
 * @param {number} delayMs - 延迟毫秒数（用于计算 alarm 延迟）
 */
export function scheduleReconnectAlarm(delayMs) {
  const delayMinutes = Math.max(delayMs / 60_000, 0.5);
  chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: delayMinutes });
}

/** 连接成功后清除重连 alarm */
export function clearReconnectAlarm() {
  chrome.alarms.clear(RECONNECT_ALARM);
}

/**
 * 初始化 alarm 监听器。
 * 在 SW 顶层调用一次，注册 onAlarm 事件处理。
 *
 * @param {() => void} onReconnect - alarm 触发时的重连回调
 */
export function initAlarmListener(onReconnect) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RECONNECT_ALARM) {
      console.log("[Alarm] Reconnect alarm fired, attempting reconnect...");
      onReconnect();
    }
  });
}
