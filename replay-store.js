'use strict';

// ---------------------------------------------------------------------------
// 演出复盘 · 只读事件日志存储
// ---------------------------------------------------------------------------
// 仅读取 data/events-<sessionId>.jsonl，绝不写入、绝不触碰当前演出内存状态。
// 一个日志文件对应一次服务进程（一个 sessionId），其中可能因「重置」包含多场：
// 每场从 session-start 起、到 sequence-finished 正常结束；中途重置/进程仍在进行
// 的场次视为未结束，不进入复盘列表。逐行解析时跳过损坏记录并生成告警，
// 任何一行坏数据都不会中断整场（或整个文件）的解析。
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const FILE_RE = /^events-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
const RUN_ID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-r(\d+)$/;

function isFiniteTs(value) {
  return typeof value === 'string' && value !== '' && Number.isFinite(Date.parse(value));
}

// 逐行解析单个 JSONL 文件：损坏行（空 JSON / 非对象 / 缺 ts/event）只告警、跳过。
// 返回 { sessionId, events, warnings }；events 保持文件原始顺序（同毫秒事件的顺序
// 即服务端写盘顺序，确定性重放依赖于此）。
function parseLogFile(filePath) {
  const base = path.basename(filePath);
  const m = FILE_RE.exec(base);
  const sessionId = m ? m[1] : null;
  const warnings = [];
  const events = [];

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { sessionId, events, warnings, readError: err.code || 'read-failed' };
  }

  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue; // 末尾换行/空行不算损坏
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      warnings.push({ line: i + 1, reason: 'JSON 解析失败', raw: line.slice(0, 120) });
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      warnings.push({ line: i + 1, reason: '记录不是 JSON 对象', raw: line.slice(0, 120) });
      continue;
    }
    if (!isFiniteTs(entry.ts)) {
      warnings.push({ line: i + 1, reason: '缺少合法的 ts 时间戳', raw: line.slice(0, 120) });
      continue;
    }
    if (typeof entry.event !== 'string' || !entry.event) {
      warnings.push({ line: i + 1, reason: '缺少合法的 event 名称', raw: line.slice(0, 120) });
      continue;
    }
    events.push({
      ts: entry.ts,
      tsMs: Date.parse(entry.ts),
      event: entry.event,
      detail: entry.detail && typeof entry.detail === 'object' && !Array.isArray(entry.detail) ? entry.detail : {},
      line: i + 1,
    });
  }
  return { sessionId, events, warnings };
}

// 把一个日志文件切分为若干「场」：session-start 开场，sequence-finished 正常收场；
// session-reset 会把进行中的场标记为中断（interrupted），不计入复盘。
// 第一场之前（如上线/保存序列）与最后一场之后（如下线）的事件均不属于任何场。
function segmentRuns(parsed) {
  const runs = [];
  let current = null; // { runIndex, startIndex, endIndex, finished, timeoutSec }
  let runSeq = 0;
  let lastTimeoutSec = null; // 最近一次 sequence-set / draft-published 的确认时限

  const interruptCurrent = (idx) => {
    if (current) {
      current.endIndex = idx - 1;
      current.finished = false;
      current = null;
    }
  };

  parsed.events.forEach((e, idx) => {
    if (e.event === 'sequence-set' || e.event === 'draft-published') {
      const sec = Number(e.detail && e.detail.timeoutSec);
      if (Number.isFinite(sec) && sec > 0) lastTimeoutSec = sec;
      return;
    }
    if (e.event === 'session-start') {
      interruptCurrent(idx); // 防御：正常流程 start 只会发生在 idle
      runSeq += 1;
      current = {
        runIndex: runSeq,
        startIndex: idx,
        endIndex: -1,
        finished: false,
        timeoutSec: lastTimeoutSec,
      };
      return;
    }
    if (!current) return;
    if (e.event === 'sequence-finished') {
      current.endIndex = idx;
      current.finished = true;
      runs.push(current);
      current = null;
      return;
    }
    if (e.event === 'session-reset') {
      interruptCurrent(idx);
    }
  });
  // 文件结束时仍在进行（或已被重置但理论上不会残留）的场：未结束，不入列表
  return runs;
}

function summarizeRun(parsed, run) {
  const windowEvents = parsed.events.slice(run.startIndex, run.endIndex + 1);
  const cueSeqs = new Set();
  let confirmCount = 0;
  let timeoutCount = 0;
  let pausedCount = 0;
  let recallCount = 0;
  let substitutionCount = 0;
  const positionSet = new Set();
  for (const e of windowEvents) {
    const d = e.detail || {};
    if (e.event === 'cue-started') {
      cueSeqs.add(Number(d.seq));
      (Array.isArray(d.targets) ? d.targets : []).forEach((t) => positionSet.add(String(t)));
    }
    if (e.event === 'confirm' || e.event === 'confirm-late') confirmCount += 1;
    if (e.event === 'cue-timeout') timeoutCount += 1;
    if (e.event === 'cue-paused') pausedCount += 1;
    if (e.event === 'cue-recalled') recallCount += 1;
    if (e.event === 'position-substituted') {
      substitutionCount += 1;
      if (d.to) positionSet.add(String(d.to));
    }
  }
  const startEvent = parsed.events[run.startIndex];
  const endEvent = parsed.events[run.endIndex];
  return {
    id: `${parsed.sessionId}-r${run.runIndex}`,
    sessionId: parsed.sessionId,
    runIndex: run.runIndex,
    startedAt: startEvent.ts,
    finishedAt: endEvent.ts,
    durationMs: endEvent.tsMs - startEvent.tsMs,
    timeoutSec: run.timeoutSec,
    cueCount: cueSeqs.size,
    eventCount: windowEvents.length,
    confirmCount,
    timeoutCount,
    pausedCount,
    recallCount,
    substitutionCount,
    positions: [...positionSet].sort(),
    warningCount: parsed.warnings.length,
  };
}

// 列出 data 目录下全部「已结束场次」（含当前日志文件中已完成、之后才被重置的场）。
// 返回 { runs, warnings }；warnings 按文件汇总解析告警。
function listFinishedRuns(dataDir) {
  let files = [];
  try {
    files = fs.readdirSync(dataDir);
  } catch {
    return { runs: [], warnings: [] };
  }
  const runs = [];
  const warnings = [];
  for (const file of files.sort()) {
    if (!FILE_RE.test(file)) continue;
    const parsed = parseLogFile(path.join(dataDir, file));
    if (!parsed.sessionId) continue;
    if (parsed.warnings.length) {
      warnings.push({
        sessionId: parsed.sessionId,
        count: parsed.warnings.length,
        sample: parsed.warnings.slice(0, 3),
      });
    }
    for (const run of segmentRuns(parsed)) {
      if (run.finished) runs.push(summarizeRun(parsed, run));
    }
  }
  runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  return { runs, warnings };
}

// 读取单场：返回 { run, events, warnings }；未结束/不存在返回 null。
// events 为该场窗口（session-start 之后，含 sequence-finished）内的事件，
// 已剔除解析辅助字段，按文件原始顺序排列。
function loadFinishedRun(dataDir, runId) {
  const m = RUN_ID_RE.exec(String(runId || ''));
  if (!m) return null;
  const sessionId = m[1];
  const runIndex = Number(m[2]);
  const filePath = path.join(dataDir, `events-${sessionId}.jsonl`);
  if (!fs.existsSync(filePath)) return null;

  const parsed = parseLogFile(filePath);
  const run = segmentRuns(parsed).find((r) => r.finished && r.runIndex === runIndex);
  if (!run) return null;

  const summary = summarizeRun(parsed, run);
  const events = parsed.events
    .slice(run.startIndex + 1, run.endIndex + 1)
    .map((e) => ({ ts: e.ts, event: e.event, detail: e.detail }));
  // 窗口前最近一次序列定义（用于展示本场冻结的口令快照与确认时限来源）
  let sequence = null;
  for (let i = run.startIndex - 1; i >= 0; i--) {
    const e = parsed.events[i];
    if (e.event === 'sequence-set') {
      sequence = {
        source: 'sequence-set',
        timeoutSec: Number(e.detail.timeoutSec) || null,
        cues: Array.isArray(e.detail.cues) ? e.detail.cues : null,
      };
      break;
    }
    if (e.event === 'draft-published') {
      sequence = { source: 'draft-published', timeoutSec: Number(e.detail.timeoutSec) || null };
      break;
    }
  }
  return { run: { ...summary, sequence }, events, warnings: parsed.warnings };
}

module.exports = { listFinishedRuns, loadFinishedRun, parseLogFile, segmentRuns, FILE_RE, RUN_ID_RE };
