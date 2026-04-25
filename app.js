'use strict';

const STORAGE_KEY      = 'drivingLogSessions';
const DAY_TARGET_MINS  = 40 * 60;
const NIGHT_TARGET_MINS = 10 * 60;

const MILESTONES = [
  { pct: 25,  label: 'First steps!'   },
  { pct: 50,  label: 'Halfway there!' },
  { pct: 75,  label: 'Almost done!'   },
  { pct: 100, label: 'Goal reached!'  },
];

const MILESTONE_NOTIFICATIONS = [
  { type: 'day',   threshold: DAY_TARGET_MINS   * 0.25, key: 'day-25',    msg: "You've logged 25% of your day hours! 🌱" },
  { type: 'day',   threshold: DAY_TARGET_MINS   * 0.50, key: 'day-50',    msg: 'Halfway through your day hours! ☀️' },
  { type: 'day',   threshold: DAY_TARGET_MINS   * 0.75, key: 'day-75',    msg: '75% of day hours done — almost there! 🙌' },
  { type: 'day',   threshold: DAY_TARGET_MINS,          key: 'day-100',   msg: 'Day hours complete! 40h done! 🎉' },
  { type: 'night', threshold: NIGHT_TARGET_MINS * 0.25, key: 'night-25',  msg: "You've logged 25% of your night hours! 🌙" },
  { type: 'night', threshold: NIGHT_TARGET_MINS * 0.50, key: 'night-50',  msg: 'Halfway through your night hours! ⭐' },
  { type: 'night', threshold: NIGHT_TARGET_MINS * 0.75, key: 'night-75',  msg: '75% of night hours done — so close! 🌟' },
  { type: 'night', threshold: NIGHT_TARGET_MINS,        key: 'night-100', msg: 'Night hours complete! 10h done! 🎉' },
];

let sessions        = [];
let editingId       = null;
let barsAnimated    = false;
let historyView     = 'all';
let collapsedGroups = new Set();
let pendingDelete     = null;
let pendingDeleteTimer = null;
let previousDayMinutes   = 0;
let previousNightMinutes = 0;
let dashboardAnimId      = 0;

// ---- Persistence ----

function loadSessions() {
  try {
    sessions = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    sessions = [];
  }
}

function saveSessions() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ---- Time / formatting utilities ----

function calcTotalMinutes(start, end) {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  let startMins = sh * 60 + sm;
  let endMins   = eh * 60 + em;
  if (endMins <= startMins) endMins += 1440; // overnight
  return endMins - startMins;
}

function fmtDuration(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function fmtHours(mins) {
  return (mins / 60).toFixed(1);
}

function fmtDate(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[mo - 1]} ${d}, ${y}`;
}

function fmtTime(t) {
  const [h, m] = t.split(':').map(Number);
  const ampm = h < 12 ? 'AM' : 'PM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${ampm}`;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function fmtDateObj(d) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// ---- Computed stats ----

function getTotals() {
  return sessions.reduce(
    (acc, s) => { acc.day += s.dayMinutes; acc.night += s.nightMinutes; return acc; },
    { day: 0, night: 0 }
  );
}

function getSupervisorStats() {
  const map = {};
  for (const s of sessions) {
    const name = s.supervisor || 'Unknown';
    if (!map[name]) map[name] = { day: 0, night: 0 };
    map[name].day   += s.dayMinutes;
    map[name].night += s.nightMinutes;
  }
  return Object.entries(map)
    .map(([name, { day, night }]) => ({ name, day, night, total: day + night }))
    .sort((a, b) => b.total - a.total);
}

// ---- ETA calculation ----

// Hybrid algorithm that improves accuracy as session count grows.
//
// Tier 1 (1–2 sessions): simple average — total minutes ÷ days elapsed.
// Tier 2 (3–6 sessions): weighted moving average of the last 3 sessions
//   (weights 3/2/1 newest-to-oldest), normalised over the days covered.
// Tier 3 (7+ sessions): 7-day rolling window — sum of minutes in the last
//   7 calendar days divided by 7.
//
// Returns { dayEta, nightEta, dayRate, nightRate, confidence, sessionCount }
// where *Eta is a Date, 'achieved', or null (rate = 0 → no projection).
function calculateEstimatedCompletion() {
  const n = sessions.length;
  if (n === 0) return null;

  const { day: totalDay, night: totalNight } = getTotals();

  const today = new Date();
  today.setHours(12, 0, 0, 0);

  const sorted = [...sessions].sort((a, b) => a.date.localeCompare(b.date));

  function noon(dateStr) {
    return new Date(dateStr + 'T12:00:00');
  }

  function calDays(a, b) {
    return Math.max(0, Math.round((b - a) / 86400000));
  }

  function projectDate(ratePerDay, remainingMins) {
    if (remainingMins <= 0) return 'achieved';
    if (ratePerDay <= 0)    return null;
    const d = new Date(today);
    d.setDate(d.getDate() + Math.ceil(remainingMins / ratePerDay));
    return d;
  }

  let dayRate   = 0;
  let nightRate = 0;
  let tier;

  if (n <= 2) {
    // ── Tier 1: simple average rate ────────────────────────────────────────
    tier = 1;
    const elapsed = Math.max(1, calDays(noon(sorted[0].date), today));
    dayRate   = totalDay   / elapsed;
    nightRate = totalNight / elapsed;

  } else if (n <= 6) {
    // ── Tier 2: weighted moving average of last 3 sessions ─────────────────
    // Weights [1, 2, 3] map to [oldest, middle, most-recent] of the window.
    tier = 2;
    const last3  = sorted.slice(-3);
    const W      = [1, 2, 3];
    const wDay   = last3.reduce((s, sess, i) => s + W[i] * sess.dayMinutes,   0);
    const wNight = last3.reduce((s, sess, i) => s + W[i] * sess.nightMinutes, 0);
    // Divide by days since the oldest session in the window to get a
    // weighted daily rate (recent-heavy sessions raise the projection).
    const span = Math.max(1, calDays(noon(last3[0].date), today));
    dayRate   = wDay   / span;
    nightRate = wNight / span;

  } else {
    // ── Tier 3: 7-day rolling average ──────────────────────────────────────
    tier = 3;
    const cutoff = new Date(today);
    cutoff.setDate(today.getDate() - 6); // window: 6 days ago → today (7 days)

    let wDay = 0, wNight = 0;
    for (const s of sessions) {
      if (noon(s.date) >= cutoff) {
        wDay   += s.dayMinutes;
        wNight += s.nightMinutes;
      }
    }
    dayRate   = wDay   / 7;
    nightRate = wNight / 7;

    // Rolling window is empty (no sessions in the last 7 days — e.g. user
    // hasn't driven recently). Fall back to the overall simple average so
    // rates never collapse to zero just because of a gap in activity.
    if (dayRate === 0 && nightRate === 0) {
      const elapsed = Math.max(1, calDays(noon(sorted[0].date), today));
      dayRate   = totalDay   / elapsed;
      nightRate = totalNight / elapsed;
    }
  }

  const debugElapsed = calDays(noon(sorted[0].date), today);
  console.log(
    '[ETA] tier=%d  sessions=%d  elapsed_days=%d  dayRate=%.2f min/day  nightRate=%.2f min/day',
    tier, n, debugElapsed, dayRate, nightRate
  );

  const remDay   = Math.max(0, DAY_TARGET_MINS   - totalDay);
  const remNight = Math.max(0, NIGHT_TARGET_MINS - totalNight);

  return {
    dayEta:       projectDate(dayRate,   remDay),
    nightEta:     projectDate(nightRate, remNight),
    dayRate,
    nightRate,
    confidence:   tier === 1 ? 'low' : tier === 2 ? 'fair' : 'good',
    sessionCount: n,
  };
}

// ---- History grouping helpers ----

function setHistoryView(v) {
  historyView = v;
  renderHistory();
}

function weekKey(dateStr) {
  const d   = new Date(dateStr + 'T12:00:00');
  const dow = d.getDay();
  const mon = new Date(d);
  mon.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  return mon.toISOString().slice(0, 10); // Monday of the week
}

function groupLabel(key, view) {
  if (view === 'week') {
    return 'Week of ' + fmtDateObj(new Date(key + 'T12:00:00'));
  }
  const [y, m] = key.split('-').map(Number);
  const LONG = ['January','February','March','April','May','June',
                 'July','August','September','October','November','December'];
  return LONG[m - 1] + ' ' + y;
}

// ---- Render: Dashboard ----

function renderDashboard() {
  const { day, night } = getTotals();
  const total      = day + night;
  const overallPct = Math.min(100, (total / (DAY_TARGET_MINS + NIGHT_TARGET_MINS)) * 100);

  document.getElementById('overall-pct').textContent = Math.round(overallPct) + '%';

  const fromDay   = previousDayMinutes;
  const fromNight = previousNightMinutes;
  previousDayMinutes   = day;
  previousNightMinutes = night;

  const animId   = ++dashboardAnimId;
  const start    = performance.now();
  const DURATION = 1200;

  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

  function tick(now) {
    if (animId !== dashboardAnimId) return; // a newer call has taken over

    const raw = Math.min(1, (now - start) / DURATION);
    const e   = easeOut(raw);

    const curDay   = fromDay   + (day   - fromDay)   * e;
    const curNight = fromNight + (night - fromNight) * e;

    const dayPct   = Math.min(100, (curDay   / DAY_TARGET_MINS)   * 100);
    const nightPct = Math.min(100, (curNight / NIGHT_TARGET_MINS) * 100);

    document.getElementById('day-logged').textContent    = fmtHours(curDay);
    document.getElementById('day-remaining').textContent = fmtHours(Math.max(0, DAY_TARGET_MINS   - curDay));
    document.getElementById('day-pct').textContent       = Math.round(dayPct) + '%';

    document.getElementById('night-logged').textContent    = fmtHours(curNight);
    document.getElementById('night-remaining').textContent = fmtHours(Math.max(0, NIGHT_TARGET_MINS - curNight));
    document.getElementById('night-pct').textContent       = Math.round(nightPct) + '%';

    document.getElementById('day-bar').style.width   = dayPct + '%';
    document.getElementById('night-bar').style.width = nightPct + '%';

    if (raw < 1) requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}

// ---- Render: Milestone Badges ----

function badgeHTML({ pct, label }, currentPct, typeClass) {
  if (currentPct >= pct) {
    return `<div class="milestone-badge earned ${typeClass}">` +
      `<span class="m-icon">&#9733;</span>` +
      `<span class="m-pct">${pct}%</span>` +
      `<span class="m-label">${label}</span>` +
      `</div>`;
  }
  return `<div class="milestone-badge locked">` +
    `<span class="m-icon">&#9711;</span>` +
    `<span class="m-pct">${pct}%</span>` +
    `</div>`;
}

function renderMilestoneBadges() {
  const { day, night } = getTotals();
  const dayPct   = (day   / DAY_TARGET_MINS)   * 100;
  const nightPct = (night / NIGHT_TARGET_MINS) * 100;

  document.getElementById('day-milestones').innerHTML =
    MILESTONES.map(m => badgeHTML(m, dayPct,   'day-milestone')).join('');
  document.getElementById('night-milestones').innerHTML =
    MILESTONES.map(m => badgeHTML(m, nightPct, 'night-milestone')).join('');
}

// ---- Render: ETA ----

function renderETA() {
  const el   = document.getElementById('eta-content');
  const data = calculateEstimatedCompletion();

  if (!data) {
    el.innerHTML = '<p class="eta-insufficient">Log your first session to see an estimate.</p>';
    return;
  }

  const { dayEta, nightEta, dayRate, nightRate, confidence, sessionCount } = data;

  function etaCell(eta) {
    if (eta === 'achieved') return '<span class="eta-achieved">Goal reached! &#x1F389;</span>';
    if (!eta)               return '<span class="eta-no-rate">Log another session to see an estimate</span>';
    return fmtDateObj(eta);
  }

  function rateCell(ratePerDay) {
    if (ratePerDay <= 0) return '';
    return `<span class="eta-rate">${fmtHours(ratePerDay)}h/day</span>`;
  }

  const CONF_LABELS = {
    low:  `Low confidence &middot; ${sessionCount} session${sessionCount === 1 ? '' : 's'} logged`,
    fair: `Fair confidence &middot; ${sessionCount} sessions logged`,
    good: `Good confidence &middot; ${sessionCount} sessions logged`,
  };

  const dayRow = `<div class="eta-row">` +
    `<span class="eta-type day-type">Day</span>` +
    `<span class="eta-date">${etaCell(dayEta)}</span>` +
    rateCell(dayRate) +
    `</div>`;

  const nightRow = `<div class="eta-row">` +
    `<span class="eta-type night-type">Night</span>` +
    `<span class="eta-date">${etaCell(nightEta)}</span>` +
    rateCell(nightRate) +
    `</div>`;

  el.innerHTML = dayRow + nightRow +
    `<div class="eta-confidence">` +
    `<span class="confidence-badge confidence-${confidence}">${CONF_LABELS[confidence]}</span>` +
    `</div>`;
}

// ---- Render: Session History ----

function sessionItemHTML(s) {
  const totalMins = s.dayMinutes + s.nightMinutes;
  return `
    <div class="session-item">
      <div class="session-header">
        <span class="session-date">${fmtDate(s.date)}</span>
        <span class="session-duration">${fmtDuration(totalMins)}</span>
      </div>
      <div class="session-time-range">${fmtTime(s.startTime)} &ndash; ${fmtTime(s.endTime)}</div>
      <div class="session-split">
        <span class="badge day-badge">Day: ${fmtDuration(s.dayMinutes)}</span>
        <span class="badge night-badge">Night: ${fmtDuration(s.nightMinutes)}</span>
      </div>
      <div class="session-details">
        <span>${s.supervisor || '—'}</span>
        <span>${s.location  || '—'}</span>
        <span class="weather-tag">${s.weather}</span>
      </div>
      <div class="session-actions">
        <button class="btn btn-sm btn-edit"   onclick="editSession('${s.id}')">Edit</button>
        <button class="btn btn-sm btn-delete" onclick="deleteSession('${s.id}')">Delete</button>
      </div>
    </div>`;
}

function renderHistory() {
  const el = document.getElementById('session-list');

  document.querySelectorAll('.view-toggle .toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === historyView);
  });

  if (!sessions.length) {
    el.innerHTML = '<p class="empty-state">No sessions logged yet. Add your first drive above!</p>';
    return;
  }

  const sorted = [...sessions].sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    return b.startTime.localeCompare(a.startTime);
  });

  if (historyView === 'all') {
    el.innerHTML = sorted.map(sessionItemHTML).join('');
    return;
  }

  const groups = new Map();
  for (const s of sorted) {
    const key = historyView === 'week' ? weekKey(s.date) : s.date.slice(0, 7);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  let html = '';
  for (const [key, gs] of groups) {
    const dayMins    = gs.reduce((t, s) => t + s.dayMinutes,   0);
    const nightMins  = gs.reduce((t, s) => t + s.nightMinutes, 0);
    const isCollapsed = collapsedGroups.has(key);
    const chevronSVG =
      `<svg class="section-chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">` +
        `<path d="M3 6l5 5 5-5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>` +
      `</svg>`;
    html +=
      `<div class="group-header${isCollapsed ? ' collapsed' : ''}" data-group-key="${key}">` +
        `<span class="group-label">${groupLabel(key, historyView)}</span>` +
        `<div class="group-header-right">` +
          `<div class="group-subtotals">` +
            `<span class="badge day-badge">${fmtHours(dayMins)}h day</span>` +
            `<span class="badge night-badge">${fmtHours(nightMins)}h night</span>` +
            `<span class="badge total-badge">${fmtHours(dayMins + nightMins)}h total</span>` +
          `</div>` +
          chevronSVG +
        `</div>` +
      `</div>` +
      `<div class="group-body${isCollapsed ? ' collapsed' : ''}">` +
        gs.map(sessionItemHTML).join('') +
      `</div>`;
  }
  el.innerHTML = html;
}

// ---- Chart data + render ----

function buildChartData() {
  if (!sessions.length) return null;
  const sorted = [...sessions].sort((a, b) => a.date.localeCompare(b.date));
  const dayMap = {}, nightMap = {};
  for (const s of sorted) {
    dayMap[s.date]   = (dayMap[s.date]   || 0) + s.dayMinutes;
    nightMap[s.date] = (nightMap[s.date] || 0) + s.nightMinutes;
  }
  const dates = [...new Set(sorted.map(s => s.date))];
  let cd = 0, cn = 0;
  return dates.map(d => {
    cd += (dayMap[d]   || 0) / 60;
    cn += (nightMap[d] || 0) / 60;
    return { date: d, day: cd, night: cn };
  });
}

function renderChart() {
  const canvas = document.getElementById('progress-chart');
  if (!canvas) return;
  const W = canvas.offsetWidth;
  const H = canvas.offsetHeight;
  if (!W || !H) return;

  const dpr = window.devicePixelRatio || 1;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const cs      = getComputedStyle(document.documentElement);
  const DAY_C   = cs.getPropertyValue('--day').trim();
  const NIGHT_C = cs.getPropertyValue('--night').trim();
  const GRID_C  = cs.getPropertyValue('--accent').trim();
  const LABEL_C = cs.getPropertyValue('--text-light').trim();
  const TEXT_C  = cs.getPropertyValue('--text-dark').trim();
  const MON     = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const pts = buildChartData();

  if (!pts) {
    ctx.fillStyle = LABEL_C; ctx.font = '13px system-ui,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Log sessions to see your progress chart.', W / 2, H / 2);
    return;
  }

  const n  = pts.length;
  const ml = 40, mr = 12, mt = 22, mb = 28;
  const cW = W - ml - mr, cH = H - mt - mb;

  // Scales
  const maxData = Math.max(...pts.map(p => Math.max(p.day, p.night)));
  const maxY    = Math.max(DAY_TARGET_MINS / 60, Math.ceil(maxData + 2));

  const dateMs  = pts.map(p => new Date(p.date + 'T12:00:00').getTime());
  const ms0     = dateMs[0];
  const rawSpan = dateMs[n - 1] - ms0;
  const span    = rawSpan > 0 ? rawSpan + rawSpan * 0.04 : 86400000;

  const xOf = ms => ml + ((ms - ms0) / span) * cW;
  const yOf = h  => mt + cH - (h / maxY) * cH;

  // Y-axis grid + labels
  const yStep = maxY > 30 ? 10 : maxY > 15 ? 5 : maxY > 6 ? 2 : 1;
  ctx.font = '10px system-ui,sans-serif'; ctx.textBaseline = 'middle';
  for (let h = 0; h <= maxY; h += yStep) {
    const y = yOf(h);
    ctx.strokeStyle = GRID_C; ctx.lineWidth = 1; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + cW, y); ctx.stroke();
    ctx.fillStyle = LABEL_C; ctx.textAlign = 'right';
    ctx.fillText(h + 'h', ml - 5, y);
  }

  // Dashed goal lines
  function goalLine(targetH, color) {
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = 1;
    ctx.globalAlpha = 0.38;  ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(ml, yOf(targetH)); ctx.lineTo(ml + cW, yOf(targetH)); ctx.stroke();
    ctx.restore();
  }
  goalLine(40, DAY_C);
  goalLine(10, NIGHT_C);

  // X-axis date labels (up to 5)
  ctx.fillStyle = LABEL_C; ctx.font = '10px system-ui,sans-serif';
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'center';
  const xStep  = Math.max(1, Math.ceil(n / 5));
  const shownX = new Set();
  for (let i = 0; i < n; i += xStep) shownX.add(i);
  shownX.add(n - 1);
  for (const i of shownX) {
    const [, mo, d] = pts[i].date.split('-').map(Number);
    ctx.fillText(`${MON[mo - 1]} ${d}`, xOf(dateMs[i]), H - 8);
  }

  // Area + line + dots per series
  function drawSeries(key, color, fillAlpha) {
    ctx.setLineDash([]);
    // Filled area
    ctx.beginPath();
    ctx.moveTo(xOf(dateMs[0]), yOf(0));
    for (let i = 0; i < n; i++) ctx.lineTo(xOf(dateMs[i]), yOf(pts[i][key]));
    ctx.lineTo(xOf(dateMs[n - 1]), yOf(0));
    ctx.closePath();
    ctx.fillStyle = color; ctx.globalAlpha = fillAlpha; ctx.fill(); ctx.globalAlpha = 1;
    // Line
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      i === 0 ? ctx.moveTo(xOf(dateMs[i]), yOf(pts[i][key]))
              : ctx.lineTo(xOf(dateMs[i]), yOf(pts[i][key]));
    }
    ctx.strokeStyle = color; ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
    // Dots
    ctx.fillStyle = color;
    for (let i = 0; i < n; i++) {
      ctx.beginPath();
      ctx.arc(xOf(dateMs[i]), yOf(pts[i][key]), 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawSeries('night', NIGHT_C, 0.10);
  drawSeries('day',   DAY_C,   0.13);

  // Legend
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.font = '11px system-ui,sans-serif';
  function legend(x, y, color, label) {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = TEXT_C;
    ctx.fillText(label, x + 8, y);
  }
  legend(ml + 2,  mt - 10, DAY_C,   'Day hours');
  legend(ml + 74, mt - 10, NIGHT_C, 'Night hours');
}

// ---- Render: Supervisor Leaderboard ----

function renderSupervisorStats() {
  const el    = document.getElementById('supervisor-list');
  const stats = getSupervisorStats();

  if (!stats.length) {
    el.innerHTML = '<p class="empty-state">No sessions logged yet.</p>';
    return;
  }

  const medalClass = i => i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';

  el.innerHTML = stats.map((s, i) => `
    <div class="supervisor-item">
      <div class="supervisor-rank ${medalClass(i)}">#${i + 1}</div>
      <div class="supervisor-info">
        <div class="supervisor-name">${s.name}</div>
        <div class="supervisor-breakdown">
          <span class="badge day-badge">Day: ${fmtHours(s.day)}h</span>
          <span class="badge night-badge">Night: ${fmtHours(s.night)}h</span>
          <span class="badge total-badge">Total: ${fmtHours(s.total)}h</span>
        </div>
      </div>
    </div>`).join('');
}

function renderAll() {
  renderDashboard();
  renderMilestoneBadges();
  renderETA();
  renderChart();
  renderHistory();
  renderSupervisorStats();
}

// ---- Form wiring ----

function initForm() {
  document.getElementById('session-date').value = todayStr();

  const startEl    = document.getElementById('start-time');
  const endEl      = document.getElementById('end-time');
  const dayMinsEl  = document.getElementById('day-mins');
  const nightMinsEl = document.getElementById('night-mins');
  const totalEl    = document.getElementById('total-display');
  const splitError = document.getElementById('split-error');

  function updateTotalDisplay() {
    if (!startEl.value || !endEl.value) return;
    const total = calcTotalMinutes(startEl.value, endEl.value);
    totalEl.textContent = fmtDuration(total);
    dayMinsEl.max   = total;
    nightMinsEl.max = total;
    // Auto-fill only when no manual edit has been made (fresh session entry)
    if (!dayMinsEl.dataset.manualEdit) {
      dayMinsEl.value   = total;
      nightMinsEl.value = 0;
    }
    hideSplitError();
  }

  startEl.addEventListener('change', updateTotalDisplay);
  endEl.addEventListener('change',   updateTotalDisplay);

  dayMinsEl.addEventListener('input', () => {
    if (!startEl.value || !endEl.value) return;
    const total = calcTotalMinutes(startEl.value, endEl.value);
    const day   = Math.min(total, Math.max(0, parseInt(dayMinsEl.value) || 0));
    nightMinsEl.value = total - day;
    dayMinsEl.dataset.manualEdit = '1';
    hideSplitError();
  });

  nightMinsEl.addEventListener('input', () => {
    if (!startEl.value || !endEl.value) return;
    const total  = calcTotalMinutes(startEl.value, endEl.value);
    const night  = Math.min(total, Math.max(0, parseInt(nightMinsEl.value) || 0));
    dayMinsEl.value = total - night;
    dayMinsEl.dataset.manualEdit = '1';
    hideSplitError();
  });

  function hideSplitError() {
    splitError.hidden = true;
  }

  document.getElementById('log-form').addEventListener('submit', handleSubmit);
}

// ---- Form submit ----

function handleSubmit(e) {
  e.preventDefault();

  const startTime = document.getElementById('start-time').value;
  const endTime   = document.getElementById('end-time').value;

  if (!startTime || !endTime) {
    alert('Please enter both a start time and end time.');
    return;
  }

  const total = calcTotalMinutes(startTime, endTime);
  const day   = parseInt(document.getElementById('day-mins').value)   || 0;
  const night = parseInt(document.getElementById('night-mins').value) || 0;

  if (day + night !== total) {
    const splitError = document.getElementById('split-error');
    splitError.textContent =
      `Day (${day}m) + Night (${night}m) = ${day + night}m, but total session is ${total}m. Please adjust the split.`;
    splitError.hidden = false;
    splitError.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }

  const session = {
    id:          editingId || generateId(),
    date:        document.getElementById('session-date').value,
    startTime,
    endTime,
    dayMinutes:  day,
    nightMinutes: night,
    supervisor:  document.getElementById('supervisor').value.trim(),
    location:    document.getElementById('location').value.trim(),
    weather:     document.getElementById('weather').value,
  };

  if (editingId) {
    const idx = sessions.findIndex(s => s.id === editingId);
    if (idx >= 0) sessions[idx] = session;
    clearEditMode();
  } else {
    sessions.push(session);
  }

  saveSessions();
  renderAll();
  updateAppBadge();
  checkMilestoneNotifications();
  resetForm();
}

// ---- Edit / Delete ----

function editSession(id) {
  const s = sessions.find(s => s.id === id);
  if (!s) return;

  editingId = id;

  document.getElementById('session-date').value  = s.date;
  document.getElementById('start-time').value    = s.startTime;
  document.getElementById('end-time').value      = s.endTime;
  document.getElementById('day-mins').value      = s.dayMinutes;
  document.getElementById('night-mins').value    = s.nightMinutes;
  document.getElementById('supervisor').value    = s.supervisor;
  document.getElementById('location').value      = s.location;
  document.getElementById('weather').value       = s.weather;

  const total = calcTotalMinutes(s.startTime, s.endTime);
  document.getElementById('total-display').textContent = fmtDuration(total);
  document.getElementById('day-mins').max   = total;
  document.getElementById('night-mins').max = total;
  document.getElementById('day-mins').dataset.manualEdit = '1';
  document.getElementById('split-error').hidden = true;

  document.getElementById('form-title').textContent      = 'Edit Session';
  document.getElementById('submit-btn').textContent      = 'Update Session';
  document.getElementById('cancel-edit-btn').style.display = '';

  document.getElementById('log').scrollIntoView({ behavior: 'smooth' });
}

function deleteSession(id) {
  if (!confirm('Delete this session?')) return;

  // A toast is already showing — commit that delete before starting a new one
  if (pendingDelete !== null) commitPendingDelete();

  pendingDelete = sessions.find(s => s.id === id);
  sessions = sessions.filter(s => s.id !== id);
  renderAll();
  updateAppBadge();

  showDeleteToast();
  pendingDeleteTimer = setTimeout(commitPendingDelete, 5000);
}

function commitPendingDelete() {
  if (pendingDelete === null) return;
  saveSessions();
  pendingDelete = null;
  clearTimeout(pendingDeleteTimer);
  pendingDeleteTimer = null;
  hideDeleteToast();
}

function undoDelete() {
  if (pendingDelete === null) return;
  clearTimeout(pendingDeleteTimer);
  pendingDeleteTimer = null;
  sessions.push(pendingDelete);
  pendingDelete = null;
  renderAll();
  updateAppBadge();
  hideDeleteToast();
}

function showDeleteToast() {
  const toast = document.getElementById('delete-toast');
  toast.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('toast-visible')));
}

function hideDeleteToast() {
  const toast = document.getElementById('delete-toast');
  toast.classList.remove('toast-visible');
  toast.addEventListener('transitionend', () => { toast.hidden = true; }, { once: true });
}

function cancelEdit() {
  clearEditMode();
  resetForm();
}

// ---- Helpers ----

function clearEditMode() {
  editingId = null;
  document.getElementById('form-title').textContent        = 'Log Session';
  document.getElementById('submit-btn').textContent        = 'Log Session';
  document.getElementById('cancel-edit-btn').style.display = 'none';
}

function resetForm() {
  document.getElementById('log-form').reset();
  document.getElementById('session-date').value  = todayStr();
  document.getElementById('total-display').textContent = '—';
  document.getElementById('day-mins').value   = 0;
  document.getElementById('night-mins').value = 0;
  document.getElementById('split-error').hidden = true;
  delete document.getElementById('day-mins').dataset.manualEdit;
}

// ---- Notifications ----

// True background scheduled notifications require a push server and service worker push events.
// This implementation fires notifications on page load as a best-effort alternative — they will
// only trigger when the user opens the app. This is fine for a personal PWA with no backend.

function showNotification(title, body, tag, actions) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.ready.then(registration => {
    registration.showNotification(title, {
      body,
      tag,
      icon:    'icons/icon-192x192.png',
      badge:   'icons/icon-96x96.png',
      actions,
      vibrate: [200, 100, 200],
    });
  }).catch(() => {});
}

function initNotifications() {
  if (!('Notification' in window)) return;

  if (Notification.permission === 'default') {
    Notification.requestPermission();
  }

  const today = todayStr();
  const hour  = new Date().getHours();
  const hasSessionToday = sessions.some(s => s.date === today);

  if (!hasSessionToday && hour >= 20 && localStorage.getItem('lastDailyReminder') !== today) {
    showNotification('Drive Log 🚗', 'Did you drive today? Tap to log your session.', 'daily-reminder');
    localStorage.setItem('lastDailyReminder', today);
  }

  const lastWeekly       = localStorage.getItem('lastWeeklySummary');
  const todayMs          = new Date(today + 'T12:00:00').getTime();
  const lastWeeklyMs     = lastWeekly ? new Date(lastWeekly + 'T12:00:00').getTime() : 0;
  const daysSinceSummary = Math.floor((todayMs - lastWeeklyMs) / 86400000);

  if (daysSinceSummary >= 7) {
    const cutoff = new Date(today + 'T00:00:00');
    cutoff.setDate(cutoff.getDate() - 6);

    let weekMins = 0;
    for (const s of sessions) {
      if (new Date(s.date + 'T00:00:00') >= cutoff) weekMins += s.dayMinutes + s.nightMinutes;
    }

    const { day, night } = getTotals();
    const remainingMins  = Math.max(0, (DAY_TARGET_MINS + NIGHT_TARGET_MINS) - (day + night));

    showNotification(
      'Drive Log — Weekly Summary 📊',
      `This week: ${fmtDuration(weekMins)} logged. ${fmtDuration(remainingMins)} still remaining to your 50h goal!`,
      'weekly-summary'
    );
    localStorage.setItem('lastWeeklySummary', today);
  }
}

// Vibration API — Android only; iOS silently ignores navigator.vibrate
function triggerHaptic(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

// ---- Confetti ----

const DAY_CONFETTI_COLORS   = ['#52b788', '#7fd4a8', '#d8f3dc', '#ffffff'];
const NIGHT_CONFETTI_COLORS = ['#0d9498', '#38b6bb', '#7fd4a8', '#ffffff'];

function launchConfetti(colors) {
  const count = 80;
  const particles = [];

  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.className = 'confetti-particle';

    const size     = 6 + Math.random() * 6;                       // 6–12px
    const x        = Math.random() * 100;                          // % across screen
    const duration = 1500 + Math.random() * 1500;                  // 1.5–3s
    const drift    = (Math.random() - 0.5) * 200;                  // -100px to +100px
    const rotation = Math.random() * 720 - 360;                    // -360 to +360deg
    const delay    = Math.random() * 500;                          // 0–0.5s
    const color    = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = [
      `width:${size}px`,
      `height:${size}px`,
      `left:${x}vw`,
      `background:${color}`,
      `animation-duration:${duration}ms`,
      `animation-delay:${delay}ms`,
      `--drift:${drift}px`,
      `--rotation:${rotation}deg`,
    ].join(';');

    document.body.appendChild(el);
    particles.push(el);
  }

  setTimeout(() => particles.forEach(p => p.remove()), 4000);
}

function checkMilestoneNotifications() {
  const { day, night } = getTotals();
  const notified = JSON.parse(localStorage.getItem('notifiedMilestones') || '[]');
  let changed = false;

  for (const m of MILESTONE_NOTIFICATIONS) {
    const value = m.type === 'day' ? day : night;
    if (value >= m.threshold && !notified.includes(m.key)) {
      showNotification('Drive Log', m.msg, 'milestone');
      notified.push(m.key);
      changed = true;
      if (m.key === 'day-100') {
        updateAppBadge();
        triggerHaptic([100, 50, 100, 50, 300]);
        launchConfetti(DAY_CONFETTI_COLORS);
      } else if (m.key === 'night-100') {
        updateAppBadge();
        triggerHaptic([100, 50, 100, 50, 300]);
        launchConfetti(NIGHT_CONFETTI_COLORS);
      } else {
        triggerHaptic([200, 100, 200]);
      }
    }
  }

  if (changed) localStorage.setItem('notifiedMilestones', JSON.stringify(notified));
}

// ---- Badging API ----

// Shows progress toward the 50-hour driving goal as an app badge number (percentage complete).
// Visually appears only on Android (Chrome) and desktop (Chrome/Edge) when installed as a PWA.
// iOS Safari does not support the Badging API; the call fails silently there.
// No user permission is required for badging.
function updateAppBadge() {
  const { day, night } = getTotals();
  const percentage = Math.round((day + night) / (DAY_TARGET_MINS + NIGHT_TARGET_MINS) * 100);
  if (!('setAppBadge' in navigator)) return;
  if (percentage >= 100) {
    navigator.clearAppBadge().catch(() => {});
  } else {
    navigator.setAppBadge(percentage).catch(() => {});
  }
}

// ---- Bootstrap ----

loadSessions();
initForm();
renderAll();
updateAppBadge();
setTimeout(initNotifications, 5000);

// ---- PWA shortcut deep-link scroll ----

setTimeout(() => {
  const hash = window.location.hash;
  if (hash === '#log') {
    document.getElementById('log').scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.getElementById('session-date').focus();
  } else if (hash === '#progress') {
    document.getElementById('progress').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (hash === '#history') {
    document.getElementById('history').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}, 300);

window.addEventListener('resize', renderChart);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderChart);

// ---- Section collapsible toggles ----

function initSectionCollapse(toggleId, bodyId, storageKey, onExpand) {
  const toggle = document.getElementById(toggleId);
  const body   = document.getElementById(bodyId);
  if (!toggle || !body) return;

  if (localStorage.getItem(storageKey) === '1') {
    toggle.classList.add('collapsed');
    body.classList.add('collapsed');
  }

  toggle.addEventListener('click', () => {
    const nowCollapsed = body.classList.toggle('collapsed');
    toggle.classList.toggle('collapsed', nowCollapsed);
    if (nowCollapsed) localStorage.setItem(storageKey, '1');
    else {
      localStorage.removeItem(storageKey);
      if (onExpand) onExpand();
    }
  });
}

initSectionCollapse('toggle-progress',    'body-progress',    'collapse_progress');
initSectionCollapse('toggle-badges',      'body-badges',      'collapse_badges');
initSectionCollapse('toggle-estimated',   'body-estimated',   'collapse_estimated');
initSectionCollapse('toggle-chart',       'body-chart',       'collapse_chart', renderChart);
initSectionCollapse('toggle-leaderboard', 'body-leaderboard', 'collapse_leaderboard');

// ---- History collapsible ----

// Restore history collapsed state from localStorage
if (localStorage.getItem('collapse_history') === '1') {
  document.getElementById('history-section-toggle').classList.add('collapsed');
  document.getElementById('session-list').classList.add('collapsed');
}

document.getElementById('history-section-toggle').addEventListener('click', () => {
  const toggle       = document.getElementById('history-section-toggle');
  const list         = document.getElementById('session-list');
  const nowCollapsed = list.classList.toggle('collapsed');
  toggle.classList.toggle('collapsed', nowCollapsed);
  if (nowCollapsed) localStorage.setItem('collapse_history', '1');
  else localStorage.removeItem('collapse_history');
});

// Event delegation — handles group header clicks regardless of re-renders
document.getElementById('session-list').addEventListener('click', e => {
  const header = e.target.closest('.group-header');
  if (!header) return;
  const key  = header.dataset.groupKey;
  const body = header.nextElementSibling;
  if (!body || !body.classList.contains('group-body')) return;
  const nowCollapsed = body.classList.toggle('collapsed');
  header.classList.toggle('collapsed', nowCollapsed);
  if (nowCollapsed) collapsedGroups.add(key);
  else collapsedGroups.delete(key);
});

// ---- Service Worker registration ----

function showUpdateToast() {
  const toast = document.getElementById('update-toast');
  toast.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('toast-visible')));
}

function hideUpdateToast() {
  const toast = document.getElementById('update-toast');
  toast.classList.remove('toast-visible');
  toast.addEventListener('transitionend', () => { toast.hidden = true; }, { once: true });
}

if ('serviceWorker' in navigator) {
  // Reload when the new SW takes control — guarded so first-install doesn't trigger a reload
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      window.location.reload();
    });
  }

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js')
      .then(registration => {
        // Already waiting from a previous background install (e.g. hard-refresh over a pending update)
        if (registration.waiting && navigator.serviceWorker.controller) {
          showUpdateToast();
        }

        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdateToast();
            }
          });
        });
      })
      .catch(() => {});
  });
}

document.getElementById('update-toast-btn').addEventListener('click', () => {
  hideUpdateToast();
  navigator.serviceWorker.ready.then(registration => {
    if (registration.waiting) registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    // controllerchange listener (registered above) handles the reload
  });
});

document.getElementById('dismiss-update-toast-btn').addEventListener('click', hideUpdateToast);

// ---- Install banner ----

const INSTALL_DISMISSED_KEY = 'pwaInstallDismissed';
let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;

  if (!localStorage.getItem(INSTALL_DISMISSED_KEY)) {
    document.getElementById('install-banner').hidden = false;
  }
});

document.getElementById('install-btn').addEventListener('click', () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  deferredInstallPrompt.userChoice.then(() => {
    deferredInstallPrompt = null;
    document.getElementById('install-banner').hidden = true;
  });
});

document.getElementById('dismiss-btn').addEventListener('click', () => {
  document.getElementById('install-banner').hidden = true;
  localStorage.setItem(INSTALL_DISMISSED_KEY, '1');
});

window.addEventListener('appinstalled', () => {
  document.getElementById('install-banner').hidden = true;
  deferredInstallPrompt = null;
});

// ---- Export / Import ----

document.getElementById('export-btn').addEventListener('click', () => {
  const json = JSON.stringify(
    JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'),
    null,
    2
  );
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'drive-log-backup.json';
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('import-btn').addEventListener('click', () => {
  document.getElementById('import-file-input').value = '';
  document.getElementById('import-file-input').click();
});

document.getElementById('import-file-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = evt => {
    let parsed;
    try {
      parsed = JSON.parse(evt.target.result);
    } catch {
      alert('This file doesn\'t look like a valid Drive Log backup.');
      return;
    }

    const REQUIRED_KEYS = ['id', 'date', 'startTime', 'endTime', 'dayMinutes', 'nightMinutes'];
    const isValid =
      Array.isArray(parsed) &&
      parsed.every(s => REQUIRED_KEYS.every(k => Object.prototype.hasOwnProperty.call(s, k)));

    if (!isValid) {
      alert('This file doesn\'t look like a valid Drive Log backup.');
      return;
    }

    if (!confirm('This will replace all your current data. Are you sure?')) return;

    localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
    loadSessions();
    renderAll();
  };
  reader.readAsText(file);
});
