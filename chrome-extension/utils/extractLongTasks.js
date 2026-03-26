/**
 * extractLongTasks.js — Performance Tracing 脱水过滤算法
 *
 * 从 Chrome Tracing 原始事件中提取长任务及其耗时元凶，
 * 输出 LLM 友好的极简 JSON 结构。
 */

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
export function extractLongTasks(traceEvents) {
  if (!traceEvents || traceEvents.length === 0) {
    return { summary: { totalLongTasks: 0, totalBlockingTimeMs: 0 }, longTasks: [] };
  }

  // ── 步骤 A：定位主线程 ──────────────────────────────────────────────────
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

  // 预过滤：只保留主线程事件，减少后续遍历量
  const mainThreadEvents = traceEvents.filter(
    (evt) => evt.pid === mainPid && evt.tid === mainTid
  );

  // ── 步骤 B：筛选顶级长任务 ─────────────────────────────────────────────
  const longRunTasks = mainThreadEvents.filter(
    (evt) =>
      evt.name === "RunTask" &&
      (evt.ph === "X" || evt.ph === "B") &&
      typeof evt.dur === "number" &&
      evt.dur >= LONG_TASK_THRESHOLD_US
  );

  // 按开始时间排序
  longRunTasks.sort((a, b) => a.ts - b.ts);

  // ── 步骤 C + D：下钻归因 + 格式化 ─────────────────────────────────────
  let totalBlockingTimeUs = 0;

  const longTasks = longRunTasks.map((task, index) => {
    const taskStart = task.ts;
    const taskEnd   = task.ts + task.dur;

    // 计算阻塞时间（超出 50ms 的部分）
    const blockingTimeUs = task.dur - LONG_TASK_THRESHOLD_US;
    totalBlockingTimeUs += blockingTimeUs;

    // 从主线程事件中筛选出包含在此长任务时间范围内的子事件
    const children = mainThreadEvents.filter((evt) => {
      if (evt === task) return false;
      if (typeof evt.ts !== "number" || typeof evt.dur !== "number") return false;
      return evt.ts >= taskStart && (evt.ts + evt.dur) <= taskEnd;
    });

    // 筛选具有业务意义的子事件，按耗时降序排列，取 Top 5
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
