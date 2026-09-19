'use strict';

/* 演出复盘 · 确定性重放引擎
 *
 * 纯函数状态机：applyEvent(state, event) 按日志原始顺序逐条应用事件，
 * 不依赖任何定时器/挂钟时间。播放与跳转走同一条路径——跳转（seek）永远从
 * 初始状态开始重放到目标时刻，因此任意时刻得到的当前口令、确认/超时、
 * 替岗、修订与暂停状态，与顺序播放到该时刻完全一致。
 *
 * 语义与服务端 server.js 的实时状态机一一对应：
 *   cue-started       开新一轮（清空确认/超时/替岗/暂停）
 *   cue-recalled      封存当前轮为 recalled 只读历史（cue-resent 随后开新一轮）
 *   cue-resent        替换口令文本、修订号取 detail.revision
 *   cue-completed     封存当前轮为 completed 只读历史
 *   sequence-finished 全场结束
 *   confirm / confirm-late / confirm-duplicate / cue-timeout
 *   position-substituted（超时标记随确认权移交）
 *   cue-paused（冻结余量）/ cue-resumed（沿用同一轮，按余量重排截止时间）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReplayEngine = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  function toMs(ts) { return Date.parse(ts); }

  // opts.timeoutSec：本场冻结的确认时限（来自窗口前最近一次 sequence-set /
  // draft-published，由接口的 run.timeoutSec 提供）；事件本身不携带时限。
  function initialState(opts = {}) {
    return {
      phase: 'idle', // idle | active | paused | done
      currentIndex: -1,
      currentCue: null, // { seq, text, targets }
      revision: 1,
      revisionReason: null,
      attemptId: null,
      confirmations: {}, // 有效岗位 -> { late }
      timedOut: [],
      substitutions: {}, // 原岗位 -> 替补岗位
      paused: false,
      pauseReason: null,
      pausedAt: null,
      remainingMs: null,
      cueStartedAt: null, // ms
      deadline: null, // ms（恢复后为重排的截止时间）
      timeoutSec: Number(opts.timeoutSec) > 0 ? Number(opts.timeoutSec) : null,
      attempts: {}, // cueSeq -> [封存的只读轮次]
      lastCue: null, // 已完成/结束时保留的最后一条口令（展示用）
    };
  }

  function effectiveTargets(s, cue) {
    if (!cue) return [];
    return cue.targets.map((t) => (s.substitutions[t] ? s.substitutions[t] : t));
  }

  // 封存当前轮快照（对应服务端 snapshotCurrentAttempt），冻结后不再修改
  function archiveAttempt(s, endState, reason, endedAtMs) {
    const cue = s.currentCue;
    if (!cue) return;
    const list = s.attempts[cue.seq] || (s.attempts[cue.seq] = []);
    // 防御重复封存（同一轮既被 completed 又被其它终止事件引用）
    if (list.some((a) => a.attemptId === s.attemptId)) return;
    list.push({
      attemptId: s.attemptId,
      revision: s.revision,
      text: cue.text,
      startedAt: s.cueStartedAt,
      deadline: s.deadline,
      endedAt: endedAtMs,
      endState, // completed | recalled
      reason: reason || null,
      confirmations: JSON.parse(JSON.stringify(s.confirmations)),
      timedOut: [...s.timedOut],
      substitutions: JSON.parse(JSON.stringify(s.substitutions)),
    });
  }

  function resetRoundState(s) {
    s.confirmations = {};
    s.timedOut = [];
    s.substitutions = {};
    s.paused = false;
    s.pauseReason = null;
    s.pausedAt = null;
    s.remainingMs = null;
  }

  function applyEvent(s, e) {
    const d = (e && e.detail) || {};
    const now = toMs(e.ts);
    switch (e.event) {
      case 'cue-started': {
        s.currentIndex = Number.isFinite(Number(d.seq)) ? Number(d.seq) - 1 : s.currentIndex + 1;
        s.currentCue = {
          seq: Number(d.seq) || s.currentIndex + 1,
          text: String(d.text == null ? '' : d.text),
          targets: Array.isArray(d.targets) ? d.targets.map(String) : [],
        };
        s.revision = Number(d.revision) || 1;
        s.revisionReason = null;
        s.attemptId = d.attemptId != null ? String(d.attemptId) : null;
        resetRoundState(s);
        s.cueStartedAt = now;
        s.deadline = s.timeoutSec ? now + s.timeoutSec * 1000 : null;
        s.phase = 'active';
        break;
      }
      case 'cue-recalled': {
        archiveAttempt(s, 'recalled', d.reason ? String(d.reason) : null, now);
        break;
      }
      case 'cue-resent': {
        // 与 cue-recalled 同毫秒成对出现（cue-recalled 先、cue-resent 后）：
        // 旧轮通常已在 cue-recalled 封存；若 cue-recalled 行损坏被跳过，此处兜底封存。
        if (s.currentCue && !lastArchiveIsCurrent(s)) {
          archiveAttempt(s, 'recalled', d.reason ? String(d.reason) : null, now);
        }
        if (s.currentCue) {
          s.currentCue = { ...s.currentCue, text: String(d.text == null ? s.currentCue.text : d.text) };
        }
        s.revision = Number(d.revision) || s.revision + 1;
        s.revisionReason = d.reason ? String(d.reason) : null;
        s.attemptId = d.attemptId != null ? String(d.attemptId) : s.attemptId;
        resetRoundState(s);
        s.cueStartedAt = now;
        s.deadline = s.timeoutSec ? now + s.timeoutSec * 1000 : null;
        s.phase = 'active';
        break;
      }
      case 'cue-completed': {
        archiveAttempt(s, 'completed', null, now);
        s.lastCue = s.currentCue ? { ...s.currentCue } : s.lastCue;
        resetRoundState(s);
        s.attemptId = null;
        s.deadline = null;
        s.currentCue = null;
        // 口令间的瞬间保持 active（currentCue 为 null），
        // 只有 sequence-finished 才进入 done，避免间隙被误判为全场结束
        s.phase = 'active';
        break;
      }
      case 'sequence-finished': {
        s.lastCue = s.currentCue ? { ...s.currentCue } : s.lastCue;
        resetRoundState(s);
        s.currentCue = null;
        s.attemptId = null;
        s.deadline = null;
        s.cueStartedAt = null;
        s.phase = 'done';
        break;
      }
      case 'confirm':
      case 'confirm-late': {
        const position = String(d.position == null ? '' : d.position);
        if (!position) break;
        // 替补确认记在替补岗位名下；目标岗位以当前有效目标为准
        if (effectiveTargets(s, s.currentCue).includes(position)) {
          s.confirmations[position] = { late: e.event === 'confirm-late' };
          s.timedOut = s.timedOut.filter((t) => t !== position);
        }
        break;
      }
      case 'cue-timeout': {
        const missing = Array.isArray(d.missing) ? d.missing.map(String) : [];
        for (const pos of missing) {
          if (!s.confirmations[pos] && !s.timedOut.includes(pos)) s.timedOut.push(pos);
        }
        break;
      }
      case 'position-substituted': {
        const from = String(d.from == null ? '' : d.from);
        const to = String(d.to == null ? '' : d.to);
        if (!from || !to || !s.currentCue) break;
        s.substitutions[from] = to;
        // 超时未确认标记随确认权一起移交给替补（与服务端一致）
        if (s.timedOut.includes(from)) {
          s.timedOut = s.timedOut.map((t) => (t === from ? to : t));
        }
        break;
      }
      case 'cue-paused': {
        const remaining = s.deadline != null ? Math.max(0, s.deadline - now) : 0;
        s.paused = true;
        s.phase = 'paused';
        s.pauseReason = d.reason != null ? String(d.reason) : null;
        s.pausedAt = now;
        s.remainingMs = remaining;
        break;
      }
      case 'cue-resumed': {
        // 日志只记录秒级 remainingSec（展示用）；冻结余量沿用暂停时刻由
        // 「暂停前 deadline − 暂停时刻」确定性算出的 s.remainingMs，
        // 与服务端「deadline = 恢复时刻 + 冻结余量」完全一致、无精度损失。
        const remaining = s.remainingMs != null ? s.remainingMs : 0;
        s.paused = false;
        s.phase = 'active';
        s.pauseReason = null;
        s.pausedAt = null;
        s.remainingMs = null;
        // 沿用同一 attemptId，按冻结余量重排截止时间
        s.deadline = now + remaining;
        break;
      }
      default:
        // 上下线、租约、草稿、重复确认、旧轮次拒绝等事件不改变口令重放状态
        break;
    }
    return s;
  }

  function lastArchiveIsCurrent(s) {
    if (!s.currentCue) return false;
    const list = s.attempts[s.currentCue.seq];
    return !!(list && list.length && list[list.length - 1].attemptId === s.attemptId);
  }

  // 从起点确定性重放全部事件（供校验与构建派生数据使用）
  function replayAll(events, opts) {
    const s = initialState(opts);
    for (const e of events) applyEvent(s, e);
    return s;
  }

  // 跳转/播放共用：从起点重放，返回应用完「ts <= targetMs」全部事件后的状态。
  // 同毫秒事件在日志中相邻（cue-recalled 与 cue-resent 等），整批应用，保证
  // 跳转到该时刻与顺序播放停在该时刻的结果一致。
  function replayUntil(events, targetMs, opts) {
    const s = initialState(opts);
    for (const e of events) {
      if (toMs(e.ts) > targetMs) break;
      applyEvent(s, e);
    }
    return s;
  }

  // 计算播放时钟在 targetMs 时的派生信息（不改变状态）：
  // 暂停期间倒计时冻结，恢复后按余量顺延；deadline 已含恢复重排。
  function deriveClock(s, clockMs) {
    let remainingMs = null;
    let timedOutNow = false;
    if ((s.phase === 'active' || s.phase === 'paused') && s.currentCue) {
      if (s.paused) {
        remainingMs = s.remainingMs; // 冻结余量，不随时间流逝
      } else if (s.deadline != null) {
        remainingMs = Math.max(0, s.deadline - clockMs);
        timedOutNow = clockMs >= s.deadline;
      }
    }
    return { remainingMs, timedOutNow };
  }

  return {
    initialState,
    applyEvent,
    replayAll,
    replayUntil,
    effectiveTargets,
    deriveClock,
  };
});
