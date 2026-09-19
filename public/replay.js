'use strict';

/* 演出复盘前端：场次列表 + 可拖动口令时间轴 + 确定性重放播放器。
 * 播放与跳转共用 ReplayEngine.replayUntil（从起点重放），保证任意跳转后
 * 的当前口令、确认/超时、替岗、修订与暂停状态与顺序播放一致。只读，不建立 WebSocket。 */

const E = ReplayEngine;

// 事件 → 展示标签 / 时间轴分组 / 标记样式
const EVENT_META = {
  'session-start': { label: '演出开始', group: 'lifecycle', cls: 'm-lifecycle' },
  'cue-started': { label: '发出口令', group: 'lifecycle', cls: 'm-lifecycle' },
  'cue-completed': { label: '口令完成', group: 'lifecycle', cls: 'm-lifecycle' },
  'sequence-finished': { label: '全部口令完成', group: 'lifecycle', cls: 'm-lifecycle' },
  'confirm': { label: '岗位确认', group: 'confirm', cls: 'm-confirm' },
  'confirm-late': { label: '迟到确认', group: 'confirm', cls: 'm-late' },
  'confirm-duplicate': { label: '重复确认', group: 'confirm', cls: 'm-other' },
  'cue-timeout': { label: '确认超时', group: 'timeout', cls: 'm-timeout' },
  'position-substituted': { label: '临时替岗', group: 'substitute', cls: 'm-sub' },
  'cue-recalled': { label: '撤回并纠正重发', group: 'recall', cls: 'm-recall' },
  'cue-resent': { label: '修订版重新发出', group: 'recall', cls: 'm-recall' },
  'cue-paused': { label: '口令暂停', group: 'pause', cls: 'm-lifecycle' },
  'cue-resumed': { label: '口令恢复', group: 'pause', cls: 'm-lifecycle' },
  'paused-confirm-rejected': { label: '暂停中确认被拒', group: 'other', cls: 'm-other' },
  'stale-confirm-ignored': { label: '旧轮次确认被拒', group: 'other', cls: 'm-other' },
  'stale-timeout-ignored': { label: '旧轮次定时器被拒', group: 'other', cls: 'm-other' },
  'stale-substitute-ignored': { label: '旧轮次替岗被拒', group: 'other', cls: 'm-other' },
};
const GROUP_LABELS = {
  lifecycle: '口令生命周期', confirm: '确认 / 迟到', timeout: '超时',
  substitute: '临时替岗', recall: '撤回修订', pause: '暂停 / 恢复', other: '其他事件',
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function fmtClock(ms) {
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false }) +
    '.' + String(new Date(ms).getMilliseconds()).padStart(3, '0');
}
function fmtDur(ms) {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} 秒`;
  const m = Math.floor(s / 60);
  return `${m} 分 ${Math.round(s - m * 60)} 秒`;
}
function metaOf(ev) { return EVENT_META[ev.event] || { label: ev.event, group: 'other', cls: 'm-other' }; }
function positionsOf(ev) {
  const d = ev.detail || {};
  const out = [];
  if (d.position != null) out.push(String(d.position));
  if (Array.isArray(d.missing)) d.missing.forEach((p) => out.push(String(p)));
  if (d.from != null) out.push(String(d.from));
  if (d.to != null) out.push(String(d.to));
  if (Array.isArray(d.targets)) d.targets.forEach((p) => out.push(String(p)));
  return out;
}

// ---------------------------------------------------------------------------
// 场次列表
// ---------------------------------------------------------------------------
const listView = document.getElementById('listView');
const detailView = document.getElementById('detailView');
const runListEl = document.getElementById('runList');
const warnEl = document.getElementById('warnings');

function renderWarnings(warnings) {
  if (!warnings || warnings.length === 0) { warnEl.classList.remove('show'); warnEl.innerHTML = ''; return; }
  const total = warnings.reduce((n, w) => n + w.count, 0);
  warnEl.innerHTML = `<b>⚠ 解析告警：${total} 条损坏记录已跳过（不影响其余事件重放）</b>` +
    '<ul>' + warnings.slice(0, 8).map((w) =>
      `<li>文件 events-${esc(w.sessionId)}.jsonl：${w.count} 行损坏` +
      (w.sample && w.sample[0] ? `（如第 ${w.sample[0].line} 行：${esc(w.sample[0].reason)}）` : '') + '</li>').join('') +
    '</ul>';
  warnEl.classList.add('show');
}

async function loadList() {
  detailView.style.display = 'none';
  listView.style.display = '';
  runListEl.innerHTML = '<span class="muted">加载中…</span>';
  let data;
  try {
    data = await (await fetch('/api/replay/runs')).json();
  } catch {
    runListEl.innerHTML = '<span class="muted">加载失败，请确认服务已启动</span>';
    return;
  }
  renderWarnings(data.warnings);
  if (!data.runs.length) {
    runListEl.innerHTML = '<span class="muted">暂无已结束场次（需要完整走到「全部口令完成」的场次才会出现在这里）</span>';
    return;
  }
  runListEl.innerHTML = `<table class="run-table"><thead><tr>
    <th>#</th><th>开始时间</th><th>场次</th><th>口令</th><th>时长</th>
    <th>确认</th><th>超时</th><th>暂停</th><th>修订</th><th>替岗</th><th>岗位</th><th>告警</th><th></th>
  </tr></thead><tbody>${data.runs.map((r, i) => `<tr>
    <td>${data.runs.length - i}</td>
    <td>${esc(new Date(r.startedAt).toLocaleString('zh-CN', { hour12: false }))}</td>
    <td><span class="muted">${esc(r.sessionId.slice(0, 8))}…</span><br><span class="run-title">第 ${r.runIndex} 场</span></td>
    <td>${r.cueCount}</td>
    <td>${esc(fmtDur(r.durationMs))}</td>
    <td>${r.confirmCount}</td>
    <td>${r.timeoutCount ? `<span style="color:#ff9c9c">${r.timeoutCount}</span>` : 0}</td>
    <td>${r.pausedCount ? `<span style="color:#f0c169">${r.pausedCount}</span>` : 0}</td>
    <td>${r.recallCount ? `<span style="color:#ff8c5a">${r.recallCount}</span>` : 0}</td>
    <td>${r.substitutionCount ? `<span style="color:#c3a8ff">${r.substitutionCount}</span>` : 0}</td>
    <td>${r.positions.map((p) => esc(p)).join('、')}</td>
    <td>${r.warningCount ? `<span style="color:#f0c169">${r.warningCount}</span>` : '—'}</td>
    <td><a href="#run=${encodeURIComponent(r.id)}">复盘 ▶</a></td>
  </tr>`).join('')}</tbody></table>`;
}

// ---------------------------------------------------------------------------
// 单场复盘
// ---------------------------------------------------------------------------
const player = {
  run: null,
  events: [],
  baseMs: 0,
  endMs: 0,
  curMs: 0,
  playing: false,
  speed: 1,
  raf: null,
  lastFrame: 0,
  bands: [],   // { seq,text,targets,startMs,endMs }
  pauses: [],  // { startMs,endMs }
};

const tlEl = document.getElementById('timeline');
const tlCuesEl = document.getElementById('tlCues');
const tlPauseEl = document.getElementById('tlPauseZones');
const tlMarkersEl = document.getElementById('tlMarkers');
const tlPlayheadEl = document.getElementById('tlPlayhead');
const tlAxisEl = document.getElementById('tlAxis');
const tlTipEl = document.getElementById('tlTip');
const typeFilterEl = document.getElementById('typeFilter');
const positionFilterEl = document.getElementById('positionFilter');
const playBtn = document.getElementById('playBtn');

async function loadDetail(runId) {
  listView.style.display = 'none';
  detailView.style.display = '';
  document.getElementById('replayState').innerHTML = '<span class="muted">加载中…</span>';
  let data;
  try {
    data = await (await fetch(`/api/replay/runs/${encodeURIComponent(runId)}`)).json();
  } catch {
    document.getElementById('replayState').innerHTML = '<span class="muted">加载失败</span>';
    return;
  }
  if (data.error) {
    document.getElementById('replayState').innerHTML = `<span class="muted">${esc(data.error)}</span>`;
    return;
  }
  initPlayer(data);
}

function initPlayer(data) {
  pause();
  player.run = data.run;
  player.events = data.events;
  player.baseMs = Date.parse(data.run.startedAt);
  player.endMs = Date.parse(data.run.finishedAt);
  player.curMs = player.baseMs;
  player.speed = Number(localStorage.getItem('replaySpeed')) || 1;

  renderRunMeta(data.run, data.warnings);
  buildDerived();
  buildFilters();
  buildTimelineChrome();
  document.getElementById('endTime').textContent = fmtClock(player.endMs);
  seek(player.baseMs);
}

function renderRunMeta(run, warnings) {
  const chips = [
    `场次 ${esc(run.sessionId.slice(0, 8))}… · 第 ${run.runIndex} 场`,
    `开始 ${esc(new Date(run.startedAt).toLocaleString('zh-CN', { hour12: false }))}`,
    `时长 ${esc(fmtDur(run.durationMs))}`,
    `口令 ${run.cueCount} 条`,
    run.timeoutSec ? `确认时限 ${run.timeoutSec} 秒` : '',
    `事件 ${run.eventCount} 条`,
  ].filter(Boolean).map((t) => `<span class="chip">${t}</span>`).join('');
  document.getElementById('runMeta').innerHTML = chips;
  renderWarnings(wardsToFileWarnings(warnings));
}

// 单场接口直接返回该文件的损坏行数组，包装成列表接口同样的结构以复用告警渲染
function wardsToFileWarnings(warnings) {
  if (!warnings || !warnings.length) return [];
  return [{ sessionId: player.run.sessionId, count: warnings.length, sample: warnings.slice(0, 3) }];
}

// 遍历事件，派生口令带、暂停区间（构建仅发生一次，与筛选/播放无关）
function buildDerived() {
  player.bands = [];
  player.pauses = [];
  let band = null;
  let pauseStart = null;
  const closeBand = (ms) => { if (band) { band.endMs = ms; player.bands.push(band); band = null; } };

  for (const ev of player.events) {
    const ms = Date.parse(ev.ts);
    if (ev.event === 'cue-started') {
      closeBand(ms);
      band = {
        seq: Number(ev.detail.seq) || player.bands.length + 1,
        text: String(ev.detail.text || ''),
        targets: Array.isArray(ev.detail.targets) ? ev.detail.targets.map(String) : [],
        startMs: ms,
        endMs: player.endMs,
      };
    } else if (ev.event === 'cue-resent' && band) {
      band.text = String(ev.detail.text || band.text);
    } else if (ev.event === 'cue-completed' || ev.event === 'sequence-finished') {
      closeBand(ms);
    } else if (ev.event === 'cue-paused') {
      pauseStart = ms;
    } else if (ev.event === 'cue-resumed') {
      if (pauseStart != null) { player.pauses.push({ startMs: pauseStart, endMs: ms }); pauseStart = null; }
    }
  }
  closeBand(player.endMs);
  if (pauseStart != null) player.pauses.push({ startMs: pauseStart, endMs: player.endMs });
}

function buildFilters() {
  const groupCounts = {};
  const posSet = new Set();
  for (const ev of player.events) {
    const g = metaOf(ev).group;
    groupCounts[g] = (groupCounts[g] || 0) + 1;
    positionsOf(ev).forEach((p) => posSet.add(p));
  }
  typeFilterEl.innerHTML = '<option value="">全部类型</option>' +
    Object.keys(GROUP_LABELS).filter((g) => groupCounts[g]).map((g) =>
      `<option value="${g}">${esc(GROUP_LABELS[g])}（${groupCounts[g]}）</option>`).join('');
  typeFilterEl.value = '';
  positionFilterEl.innerHTML = '<option value="">全部岗位</option>' +
    [...posSet].sort().map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  positionFilterEl.value = '';
  typeFilterEl.onchange = renderTimeline;
  positionFilterEl.onchange = renderTimeline;

  document.querySelectorAll('#speedSeg button').forEach((btn) => {
    btn.classList.toggle('on', Number(btn.dataset.speed) === player.speed);
    btn.onclick = () => {
      player.speed = Number(btn.dataset.speed);
      localStorage.setItem('replaySpeed', player.speed);
      document.querySelectorAll('#speedSeg button').forEach((b) =>
        b.classList.toggle('on', b === btn));
    };
  });
}

function eventVisible(ev) {
  const typeF = typeFilterEl.value;
  const posF = positionFilterEl.value;
  if (typeF && metaOf(ev).group !== typeF) return false;
  if (posF && !positionsOf(ev).includes(posF)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 时间轴
// ---------------------------------------------------------------------------
const TL_PAD = 8;
function pct(ms) {
  const span = Math.max(1, player.endMs - player.baseMs);
  return ((ms - player.baseMs) / span) * 100;
}
function msFromEvent(clientX) {
  const rect = tlEl.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left - TL_PAD) / (rect.width - TL_PAD * 2)));
  return player.baseMs + ratio * (player.endMs - player.baseMs);
}

function buildTimelineChrome() {
  // 时间刻度（相对开场的秒数）
  const ticks = 6;
  tlAxisEl.innerHTML = Array.from({ length: ticks + 1 }, (_, i) => {
    const t = player.baseMs + (player.endMs - player.baseMs) * i / ticks;
    const label = `${((t - player.baseMs) / 1000).toFixed(0)}s`;
    return `<span class="tl-tick" style="left:calc(${TL_PAD}px + (100% - ${TL_PAD * 2}px) * ${i / ticks})">${label}</span>`;
  }).join('');

  document.getElementById('tlLegend').innerHTML = [
    ['#4fbf74', '确认'], ['#f0c169', '迟到'], ['#e06060', '超时'],
    ['#9c7ff0', '替岗'], ['#ff8c5a', '修订'], ['#8ab4ff', '生命周期'],
  ].map(([color, label]) => `<span class="lg"><span class="dot" style="background:${color}"></span>${label}</span>`).join('') +
    '<span class="lg">▨ 黄色斜纹区间 = 暂停（倒计时冻结）</span>';
}

function renderTimeline() {
  const posF = positionFilterEl.value;
  // 口令带
  tlCuesEl.innerHTML = player.bands.map((b) => {
    const dim = posF && !b.targets.includes(posF) ? ' dim' : '';
    const left = `calc(${TL_PAD}px + (100% - ${TL_PAD * 2}px) * ${pct(b.startMs) / 100})`;
    const width = `calc((100% - ${TL_PAD * 2}px) * ${Math.max(0, (pct(b.endMs) - pct(b.startMs)) / 100)})`;
    return `<div class="tl-cueband${dim}" style="left:${left};width:${width}" data-start="${b.startMs}"
      title="第 ${b.seq} 条：${esc(b.text)}（${esc(b.targets.join('、'))}）">
      <span class="tl-cue-seq">#${b.seq}</span><span class="tl-cue-text">${esc(b.text)}</span></div>`;
  }).join('');
  tlCuesEl.querySelectorAll('.tl-cueband').forEach((el) => {
    el.onclick = (ev) => { ev.stopPropagation(); seek(Number(el.dataset.start)); };
  });

  // 暂停区间
  tlPauseEl.innerHTML = player.pauses.map((p) => {
    const left = `calc(${TL_PAD}px + (100% - ${TL_PAD * 2}px) * ${pct(p.startMs) / 100})`;
    const width = `calc((100% - ${TL_PAD * 2}px) * ${Math.max(0, (pct(p.endMs) - pct(p.startMs)) / 100)})`;
    return `<div class="tl-pausezone" style="left:${left};width:${width}"></div>`;
  }).join('');

  // 事件标记（同毫秒横向微错位，避免完全重叠）
  const bucketTotals = new Map();
  const marks = [];
  player.events.forEach((ev, idx) => {
    if (!eventVisible(ev)) return;
    const ms = Date.parse(ev.ts);
    bucketTotals.set(ms, (bucketTotals.get(ms) || 0) + 1);
    marks.push({ ev, ms, idx });
  });
  const bucketSeen = new Map();
  tlMarkersEl.innerHTML = marks.map(({ ev, ms, idx }) => {
    const total = bucketTotals.get(ms);
    const ord = bucketSeen.get(ms) || 0;
    bucketSeen.set(ms, ord + 1);
    const jitter = total > 1 ? (ord - (total - 1) / 2) * 6 : 0;
    const left = `calc(${TL_PAD}px + (100% - ${TL_PAD * 2}px) * ${pct(ms) / 100} + ${jitter}px)`;
    const future = ms > player.curMs ? 'opacity:.3' : '';
    return `<div class="tl-marker ${metaOf(ev).cls}" data-idx="${idx}" style="left:${left};${future}"></div>`;
  }).join('');
  tlMarkersEl.querySelectorAll('.tl-marker').forEach((el) => {
    const ev = player.events[Number(el.dataset.idx)];
    el.onclick = (e) => { e.stopPropagation(); seek(Date.parse(ev.ts)); };
    el.onmouseenter = (e) => showTip(e, ev);
    el.onmouseleave = hideTip;
  });

  renderPlayhead();
}

function showTip(e, ev) {
  const d = ev.detail || {};
  const detail = Object.entries(d).map(([k, v]) =>
    `${esc(k)}=${esc(Array.isArray(v) ? v.join('/') : JSON.stringify(v))}`).join(' ');
  tlTipEl.innerHTML = `<b>${esc(fmtClock(Date.parse(ev.ts)))}</b> ${esc(metaOf(ev).label)}<br>` +
    `<span class="muted">${detail}</span>`;
  tlTipEl.style.display = 'block';
  tlTipEl.style.left = Math.min(window.innerWidth - 300, e.clientX + 12) + 'px';
  tlTipEl.style.top = (e.clientY + 14) + 'px';
}
function hideTip() { tlTipEl.style.display = 'none'; }

function renderPlayhead() {
  const left = `calc(${TL_PAD}px + (100% - ${TL_PAD * 2}px) * ${pct(player.curMs) / 100})`;
  tlPlayheadEl.style.left = left;
}

// 拖动 / 点击时间轴任意位置 → 跳转（松手即从起点确定性重放到目标时刻）
let dragging = false;
tlEl.addEventListener('pointerdown', (e) => {
  dragging = true;
  tlEl.setPointerCapture(e.pointerId);
  seek(msFromEvent(e.clientX), { keepPlay: true });
});
tlEl.addEventListener('pointermove', (e) => {
  if (dragging) seek(msFromEvent(e.clientX), { keepPlay: true });
});
tlEl.addEventListener('pointerup', () => { dragging = false; });
tlEl.addEventListener('pointercancel', () => { dragging = false; });

// ---------------------------------------------------------------------------
// 播放控制（播放只是按速率推进虚拟时钟；画面始终由确定性重放得到）
// ---------------------------------------------------------------------------
function play() {
  if (player.playing) return;
  if (player.curMs >= player.endMs) { player.curMs = player.baseMs; render(); }
  player.playing = true;
  player.lastFrame = performance.now();
  playBtn.textContent = '⏸ 暂停';
  const tick = (t) => {
    if (!player.playing) return;
    const dt = t - player.lastFrame;
    player.lastFrame = t;
    player.curMs += dt * player.speed;
    if (player.curMs >= player.endMs) {
      player.curMs = player.endMs;
      player.playing = false;
      player.raf = null;
      playBtn.textContent = '▶ 播放';
      render();
      return;
    }
    render();
    player.raf = requestAnimationFrame(tick);
  };
  player.raf = requestAnimationFrame(tick);
}
function pause() {
  player.playing = false;
  if (player.raf) cancelAnimationFrame(player.raf);
  player.raf = null;
  playBtn.textContent = '▶ 播放';
}
playBtn.onclick = () => (player.playing ? pause() : play());
document.getElementById('restartBtn').onclick = () => seek(player.baseMs);

// 跳转：唯一的状态入口——从起点 replayUntil 到目标时刻，保证与顺序播放一致
function seek(ms, { keepPlay = false } = {}) {
  if (!player.events.length && !player.run) return;
  player.curMs = Math.min(player.endMs, Math.max(player.baseMs, ms));
  if (!keepPlay && player.playing) pause();
  render();
}

document.addEventListener('keydown', (e) => {
  if (detailView.style.display === 'none') return;
  if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); player.playing ? pause() : play(); }
  else if (e.code === 'ArrowLeft') seek(player.curMs - 1000, { keepPlay: true });
  else if (e.code === 'ArrowRight') seek(player.curMs + 1000, { keepPlay: true });
});

// ---------------------------------------------------------------------------
// 状态渲染（确定性重放结果）
// ---------------------------------------------------------------------------
function render() {
  if (!player.run) return;
  renderPlayhead();
  document.getElementById('curTime').textContent = fmtClock(player.curMs);
  document.getElementById('curOffset').textContent = `${((player.curMs - player.baseMs) / 1000).toFixed(1)}s`;
  playBtn.disabled = false;

  const s = E.replayUntil(player.events, player.curMs, { timeoutSec: player.run.timeoutSec });
  const clock = E.deriveClock(s, player.curMs);
  renderStatePanel(s, clock);
  renderEventList();
  // 未来事件标记淡出（拖动时实时反馈）
  tlMarkersEl.querySelectorAll('.tl-marker').forEach((el) => {
    const ev = player.events[Number(el.dataset.idx)];
    el.style.opacity = Date.parse(ev.ts) > player.curMs ? '0.3' : '';
  });
}

function renderStatePanel(s, clock) {
  const el = document.getElementById('replayState');
  if (s.phase === 'active' && s.currentCue === null && !s.lastCue) {
    el.innerHTML = '<div class="muted" style="text-align:center;padding:20px">待开始（演出尚未发出第一条口令）</div>';
    return;
  }
  if (s.phase === 'done') {
    el.innerHTML = `<div class="big-cue">✅ 演出已结束<span class="cue-seq">共 ${player.bands.length} 条口令</span></div>` +
      renderAllAttempts(s);
    return;
  }

  const cue = s.currentCue;
  const eff = E.effectiveTargets(s, cue);
  const revBadge = s.revision > 1
    ? `<span class="rev-badge">第 ${s.revision} 版（修订）</span>`
    : '<span class="rev-badge rev-initial">第 1 版</span>';
  const reason = s.revisionReason
    ? `<div class="rev-reason">撤回原因：${esc(s.revisionReason)}</div>` : '';
  const pauseBanner = s.paused
    ? `<div class="replay-pause-banner">⏸ 已暂停：${esc(s.pauseReason || '（无原因）')}` +
      `　冻结剩余 ${Math.ceil((s.remainingMs || 0) / 1000)} 秒</div>` : '';

  let cdLine = '';
  if (cue && clock.remainingMs != null) {
    const zero = clock.remainingMs === 0;
    if (s.paused) {
      cdLine = `<div class="replay-clock">暂停中 · 冻结剩余：<span class="cd">` +
        (zero ? '0（已超时）' : `${(clock.remainingMs / 1000).toFixed(1)} 秒`) + '</span></div>';
    } else {
      cdLine = `<div class="replay-clock">确认倒计时：<span class="cd ${zero ? 'zero' : ''}">` +
        (zero ? '已超时' : `${(clock.remainingMs / 1000).toFixed(1)} 秒`) + '</span></div>';
    }
  }

  const chips = eff.map((t) => {
    let cls = '';
    let note = '待确认';
    if (s.confirmations[t]) { cls = s.confirmations[t].late ? 'chip late' : 'chip ok'; note = s.confirmations[t].late ? '迟到确认' : '已确认'; }
    else if (s.timedOut.includes(t)) { cls = 'chip timeout'; note = '超时未确认'; }
    return `<span class="chip ${cls}">${esc(t)} · ${note}</span>`;
  });
  const subNote = Object.keys(s.substitutions).length
    ? `<div class="replay-sub-note">本轮替岗：${Object.entries(s.substitutions).map(([f, t]) =>
      `${esc(f)} → ${esc(t)}`).join('；')}（仅本口令生效）</div>` : '';

  el.innerHTML = pauseBanner +
    `<div class="replay-cuepanel">
      <div class="big-cue"><span class="cue-seq">第 ${cue.seq} / ${player.bands.length} 条</span>${esc(cue.text)}</div>
      ${revBadge}${reason}${cdLine}
      <div class="replay-targets">${chips.join('')}</div>
      ${subNote}
    </div>` + renderAttemptsOf(s, cue.seq);
}

// 当前口令已封存的历史轮次（旧修订版）
function renderAttemptsOf(s, seq) {
  const list = s.attempts[seq];
  if (!list || !list.length) return '';
  return '<h2 style="margin:18px 0 8px;font-size:14px;color:#aab2c5">本条历史轮次（只读封存）</h2>' +
    list.slice().reverse().map(attemptRowHtml).join('');
}
// 结束后展示全部口令的封存轮次
function renderAllAttempts(s) {
  const seqs = Object.keys(s.attempts).map(Number).sort((a, b) => a - b);
  if (!seqs.length) return '';
  return seqs.map((seq) => {
    const band = player.bands.find((b) => b.seq === seq);
    const targets = band ? band.targets : [];
    return `<h2 style="margin:18px 0 8px;font-size:14px;color:#aab2c5">第 ${seq} 条${band ? '：' + esc(band.text) : ''}</h2>` +
      s.attempts[seq].slice().reverse().map((a) => attemptRowHtml(a, targets)).join('');
  }).join('');
}
function attemptRowHtml(a, fallbackTargets) {
  const targets = fallbackTargets || null;
  const subs = a.substitutions || {};
  const effective = targets
    ? targets.map((t) => (subs[t] ? subs[t] : t))
    : [...new Set([...Object.keys(a.confirmations), ...(a.timedOut || [])])];
  const confs = a.confirmations || {};
  const confirmed = Object.keys(confs);
  const timedOut = a.timedOut || [];
  const pending = effective.filter((t) => !confirmed.includes(t) && !timedOut.includes(t));
  const chips = [
    ...confirmed.map((t) =>
      `<span class="chip ok">${esc(t)} · 已确认${confs[t].late ? '（迟到）' : ''}</span>`),
    ...timedOut.map((t) => `<span class="chip timeout">${esc(t)} · 超时未确认</span>`),
    ...pending.map((t) =>
      `<span class="chip">${esc(t)} · 未确认（轮次${a.endState === 'recalled' ? '撤回' : '结束'}）</span>`),
  ].join('');
  const subLine = Object.keys(subs).length
    ? `<div class="attempt-sub">替岗：${Object.entries(subs).map(([f, t]) =>
      `${esc(f)} → ${esc(t)}`).join('；')}</div>` : '';
  const badge = a.endState === 'recalled'
    ? '<span class="chip timeout">已撤回封存</span>'
    : '<span class="chip ok">已完成封存</span>';
  const reasonLine = a.endState === 'recalled' && a.reason
    ? `<div class="attempt-reason">撤回原因：${esc(a.reason)}</div>` : '';
  return `<div class="attempt-row ${a.endState}">
    <div class="attempt-head">${badge}
      <span class="rev-badge rev-initial" style="margin:0">第 ${a.revision} 版</span>
      <span class="muted">${esc(fmtClock(a.startedAt))} – ${esc(fmtClock(a.endedAt))}</span></div>
    <div class="attempt-text">口令：${esc(a.text)}</div>
    ${reasonLine}
    <div class="attempt-chips">${chips || '<span class="muted">无确认记录</span>'}</div>
    ${subLine}
  </div>`;
}

// 事件流列表（应用当前筛选；未来事件淡出，最新已应用事件高亮并滚动可见）
function renderEventList() {
  const listEl = document.getElementById('eventList');
  const rows = [];
  let lastAppliedIdx = -1;
  player.events.forEach((ev, idx) => {
    if (!eventVisible(ev)) return;
    const ms = Date.parse(ev.ts);
    if (ms <= player.curMs) lastAppliedIdx = idx;
    const d = ev.detail || {};
    const detail = Object.entries(d).map(([k, v]) =>
      `${esc(k)}=${esc(Array.isArray(v) ? v.join('/') : JSON.stringify(v))}`).join(' ');
    rows.push({ idx, html: `<div class="log-row" data-idx="${idx}" style="${ms > player.curMs ? 'opacity:.35' : ''}">
      <span class="log-ts">${esc(fmtClock(ms))}</span>
      <span class="log-event">${esc(metaOf(ev).label)}</span>
      <span class="log-detail">${detail}</span></div>` });
  });
  listEl.innerHTML = rows.length
    ? rows.reverse().map((r) => r.html).join('')
    : '<span class="muted">当前筛选条件下无事件</span>';
  const hit = listEl.querySelector(`[data-idx="${lastAppliedIdx}"]`);
  if (hit) {
    hit.style.background = '#24304a';
    hit.scrollIntoView({ block: 'nearest' });
  }
}

// ---------------------------------------------------------------------------
// 路由：#run=<id> 深链接 / 返回
// ---------------------------------------------------------------------------
document.getElementById('backBtn').onclick = () => { location.hash = ''; };

function route() {
  const m = /run=([^&]+)/.exec(location.hash);
  if (m) loadDetail(decodeURIComponent(m[1]));
  else { pause(); loadList(); }
}
window.addEventListener('hashchange', route);
route();
