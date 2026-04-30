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

const DRIVING_TIPS = [
  'Keep your eyes scanning 10–15 seconds ahead of your vehicle.',
  'Check your mirrors every 5–8 seconds while driving.',
  'Always signal at least 3 seconds before turning or changing lanes.',
  'Maintain a 3-second following distance in good conditions — more in rain.',
  'Adjust your mirrors before every drive, not after you start moving.',
  'Slow down and increase following distance in wet or foggy conditions.',
  'Never drive when tired — fatigue impairs reaction time as much as alcohol.',
  'Look through the turn, not at it — your car follows your eyes.',
  'Come to a complete stop at stop signs — a rolling stop is still a violation.',
  'Use the SMOG method: Signal, Mirror, Over-the-shoulder, Go.',
  'Brake early and gently — it gives drivers behind you more reaction time.',
  'Keep both hands on the wheel in the 9 and 3 o\'clock position.',
  'Night driving requires more following distance — headlights only cover so far.',
  'In a skid, steer in the direction you want to go, don\'t brake suddenly.',
  'Always come to a stop before looking both ways at a stop sign.',
  'Scan intersections even on green — not everyone stops for red.',
  'Avoid driving in another driver\'s blind spot on the highway.',
  'When merging onto a highway, match the speed of traffic before entering.',
  'Park parallel to the curb within 12 inches when parallel parking.',
  'After driving in heavy rain, lightly tap your brakes to dry them out.',
];

let currentTipIndex = Math.floor(Math.random() * DRIVING_TIPS.length);

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

function calcStreak() {
  if (!sessions.length) return 0;

  const today  = todayStr();
  const dates  = [...new Set(sessions.map(s => s.date))].sort();
  const last   = dates[dates.length - 1];
  const todayMs = new Date(today + 'T12:00:00').getTime();
  const lastMs  = new Date(last  + 'T12:00:00').getTime();

  // Streak is broken if the most recent session was 2+ days ago
  if (Math.round((todayMs - lastMs) / 86400000) > 1) return 0;

  // Count consecutive days backwards from the most recent date
  let streak = 1;
  for (let i = dates.length - 2; i >= 0; i--) {
    const gap = Math.round(
      (new Date(dates[i + 1] + 'T12:00:00') - new Date(dates[i] + 'T12:00:00')) / 86400000
    );
    if (gap === 1) streak++;
    else break;
  }
  return streak;
}

// ---- ETA calculation ----
//
// calculateEstimatedCompletion() returns per-goal three-scenario projections:
//   Optimistic  — rate from the single best  7-day rolling window in history
//   Likely      — weighted 4-week average (most-recent week ×4, then ×3, ×2, ×1)
//   Pessimistic — rate from the single worst 7-day rolling window with ≥1 session
//
// Returns { day, night, confidence, sessionCount, enoughDataForRange }
// where day/night = { optimistic, likely, pessimistic, complete, collapsed }
// and each date is a Date object, 'achieved', 'past', or null.
function calculateEstimatedCompletion() {
  const n = sessions.length;
  if (n === 0) return null;

  const { day: totalDay, night: totalNight } = getTotals();

  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const todayMs = today.getTime();

  const sorted = [...sessions].sort((a, b) => a.date.localeCompare(b.date));

  function noon(dateStr) {
    return new Date(dateStr + 'T12:00:00');
  }

  const firstMs = noon(sorted[0].date).getTime();
  const elapsed = Math.max(1, Math.round((todayMs - firstMs) / 86400000));

  const simpleDay   = totalDay   / elapsed;
  const simpleNight = totalNight / elapsed;

  function projectDate(rate, remainingMins, fallback) {
    if (remainingMins <= 0) return 'achieved';
    const r = rate > 0 ? rate : (fallback > 0 ? fallback : 0);
    if (r <= 0) return null;
    const d = new Date(today);
    d.setDate(d.getDate() + Math.ceil(remainingMins / r));
    if (d <= today) return 'past';
    return d;
  }

  // Slide a 7-day window over all dates from (first session) to (today),
  // returning one rate per window that contained at least one session.
  function allWindowRates(type) {
    const rates = [];
    for (let endMs = firstMs + 6 * 86400000; endMs <= todayMs; endMs += 86400000) {
      const startMs = endMs - 6 * 86400000;
      let sum = 0, hasSess = false;
      for (const s of sorted) {
        const ms = noon(s.date).getTime();
        if (ms >= startMs && ms <= endMs) {
          sum += type === 'day' ? s.dayMinutes : s.nightMinutes;
          hasSess = true;
        }
      }
      if (hasSess) rates.push(sum / 7);
    }
    return rates;
  }

  // Weighted average of the last 4 calendar weeks (most-recent week = weight 4).
  function weightedFourWeekRate(type) {
    let wSum = 0, wTotal = 0;
    for (let w = 0; w < 4; w++) {
      const weight  = 4 - w;
      const endMs   = todayMs - w * 7 * 86400000;
      const startMs = endMs   - 6 * 86400000;
      let sum = 0;
      for (const s of sessions) {
        const ms = noon(s.date).getTime();
        if (ms >= startMs && ms <= endMs) {
          sum += type === 'day' ? s.dayMinutes : s.nightMinutes;
        }
      }
      wSum   += (sum / 7) * weight;
      wTotal += weight;
    }
    const r = wSum / wTotal;
    return r > 0 ? r : (type === 'day' ? simpleDay : simpleNight);
  }

  const remDay   = Math.max(0, DAY_TARGET_MINS   - totalDay);
  const remNight = Math.max(0, NIGHT_TARGET_MINS - totalNight);

  const likelyDayRate   = weightedFourWeekRate('day');
  const likelyNightRate = weightedFourWeekRate('night');

  const confidence = n <= 2 ? 'low' : n <= 6 ? 'fair' : 'good';

  if (n < 3) {
    return {
      day:   { likely: projectDate(likelyDayRate,   remDay,   simpleDay),   complete: remDay   <= 0 },
      night: { likely: projectDate(likelyNightRate, remNight, simpleNight), complete: remNight <= 0 },
      confidence,
      sessionCount: n,
      enoughDataForRange: false,
    };
  }

  const dayWins   = allWindowRates('day');
  const nightWins = allWindowRates('night');

  const rawBestDay    = dayWins.length    ? Math.max(...dayWins)               : simpleDay;
  const worstDayArr   = dayWins.filter(r => r > 0);
  const rawWorstDay   = worstDayArr.length ? Math.min(...worstDayArr)          : simpleDay;

  const rawBestNight  = nightWins.length  ? Math.max(...nightWins)             : simpleNight;
  const worstNightArr = nightWins.filter(r => r > 0);
  const rawWorstNight = worstNightArr.length ? Math.min(...worstNightArr)      : simpleNight;

  // Sort all three rates descending so finalBest >= finalLikely >= finalWorst.
  // The weighted-4-week likely rate can fall outside the window scan's range,
  // so we must sort rather than assume the window extremes bracket the middle.
  const [finalBestDayRate, finalLikelyDayRate, finalWorstDayRate] =
    [rawBestDay, likelyDayRate, rawWorstDay].sort((a, b) => b - a);

  const [finalBestNightRate, finalLikelyNightRate, finalWorstNightRate] =
    [rawBestNight, likelyNightRate, rawWorstNight].sort((a, b) => b - a);

  // Project dates from sorted rates (higher rate → fewer days → earlier date)
  let optDay    = projectDate(finalBestDayRate,    remDay,   simpleDay);
  let likelyDay = projectDate(finalLikelyDayRate,  remDay,   simpleDay);
  let pestDay   = projectDate(finalWorstDayRate,   remDay,   simpleDay);

  let optNight    = projectDate(finalBestNightRate,   remNight, simpleNight);
  let likelyNight = projectDate(finalLikelyNightRate, remNight, simpleNight);
  let pestNight   = projectDate(finalWorstNightRate,  remNight, simpleNight);

  // Belt-and-suspenders: enforce best (earliest) ≤ likely ≤ worst (latest)
  // using a three-value insertion sort on the timestamps.
  function ensureDateOrder(a, b, c) {
    function ts(d) { return d instanceof Date ? d.getTime() : Infinity; }
    if (ts(a) > ts(b)) [a, b] = [b, a];
    if (ts(b) > ts(c)) [b, c] = [c, b];
    if (ts(a) > ts(b)) [a, b] = [b, a];
    return [a, b, c];
  }

  [optDay,   likelyDay,   pestDay  ] = ensureDateOrder(optDay,   likelyDay,   pestDay);
  [optNight, likelyNight, pestNight] = ensureDateOrder(optNight, likelyNight, pestNight);

  function dStr(d) { return d instanceof Date ? fmtDateObj(d) : String(d); }
  console.log(
    '[ETA] day   rates best=%.2f likely=%.2f worst=%.2f | dates best=%s likely=%s worst=%s',
    finalBestDayRate, finalLikelyDayRate, finalWorstDayRate,
    dStr(optDay), dStr(likelyDay), dStr(pestDay)
  );
  console.log(
    '[ETA] night rates best=%.2f likely=%.2f worst=%.2f | dates best=%s likely=%s worst=%s',
    finalBestNightRate, finalLikelyNightRate, finalWorstNightRate,
    dStr(optNight), dStr(likelyNight), dStr(pestNight)
  );

  function sameDateStr(a, b) {
    if (a instanceof Date && b instanceof Date) return a.toDateString() === b.toDateString();
    return a === b;
  }

  return {
    day: {
      optimistic:  optDay,
      likely:      likelyDay,
      pessimistic: pestDay,
      complete:    remDay   <= 0,
      collapsed:   sameDateStr(optDay, pestDay),
    },
    night: {
      optimistic:  optNight,
      likely:      likelyNight,
      pessimistic: pestNight,
      complete:    remNight <= 0,
      collapsed:   sameDateStr(optNight, pestNight),
    },
    confidence,
    sessionCount: n,
    enoughDataForRange: true,
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

// ---- Collapsed header progress text ----

function updateCollapsedProgress() {
  const el = document.getElementById('collapsed-progress');
  if (!el) return;
  const { day, night } = getTotals();
  const total      = day + night;
  const totalH     = (total / 60).toFixed(1);
  const overallPct = Math.min(100, Math.round((total / (DAY_TARGET_MINS + NIGHT_TARGET_MINS)) * 100));
  el.innerHTML = `<span class="collapsed-pct">${overallPct}%</span> · ${totalH}h / 50h`;
}

// ---- Render: Dashboard ----

function renderDashboard() {
  const { day, night } = getTotals();
  const total      = day + night;
  const overallPct = Math.min(100, (total / (DAY_TARGET_MINS + NIGHT_TARGET_MINS)) * 100);

  document.getElementById('overall-pct').textContent = Math.round(overallPct) + '%';
  updateCollapsedProgress();

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

// ---- Render: Streak ----

function renderStreak() {
  const streak = calcStreak();
  const el     = document.getElementById('streak-badge');

  el.className = 'streak-badge';

  if (streak === 0) {
    el.innerHTML = 'No active streak &mdash; drive today!';
    el.classList.add('streak-none');
    return;
  }

  const flameClass = streak >= 14 ? 'streak-flame streak-flame-pulse' : 'streak-flame';
  const flame      = `<span class="${flameClass}">🔥</span>`;
  const label      = streak === 1 ? '1 day streak &mdash; keep it up!' : `${streak} day streak`;
  el.innerHTML     = `${flame} ${label}`;

  if (streak >= 7) el.classList.add('streak-hot');
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

  const { confidence, sessionCount } = data;

  const CONF_LABELS = {
    low:  `Low confidence &middot; ${sessionCount} session${sessionCount === 1 ? '' : 's'} logged`,
    fair: `Fair confidence &middot; ${sessionCount} sessions logged`,
    good: `Good confidence &middot; ${sessionCount} sessions logged`,
  };

  function etaDateStr(eta) {
    if (!eta)           return '<span class="eta-no-rate">—</span>';
    if (eta === 'past') return '<span class="eta-delayed">At current pace, goal may be delayed — drive more frequently!</span>';
    return fmtDateObj(eta);
  }

  function scenarioRow(dotClass, label, eta) {
    return `<div class="eta-scenario">` +
      `<span class="eta-dot ${dotClass}" aria-hidden="true"></span>` +
      `<span class="eta-scenario-label">${label}</span>` +
      `<span class="eta-scenario-date">${etaDateStr(eta)}</span>` +
      `</div>`;
  }

  function goalHTML(label, typeClass, goalData) {
    if (goalData.complete) {
      return `<div class="eta-goal">` +
        `<span class="eta-type ${typeClass}">${label}</span>` +
        `<span class="eta-achieved"><svg width="22" height="22" viewBox="0 0 22 22" style="vertical-align:middle;margin-right:6px" aria-hidden="true"><circle cx="11" cy="11" r="11" fill="#52b788"/><polyline points="6,11 9.5,15 16,7" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>Goal reached!</span>` +
        `</div>`;
    }

    if (!data.enoughDataForRange) {
      return `<div class="eta-goal">` +
        `<span class="eta-type ${typeClass}">${label}</span>` +
        `<div class="eta-scenarios">` +
          scenarioRow('eta-dot-likely', 'Most likely', goalData.likely) +
          `<p class="eta-range-note">Log more sessions to see best &amp; worst case estimates</p>` +
        `</div>` +
        `</div>`;
    }

    if (goalData.collapsed) {
      return `<div class="eta-goal">` +
        `<span class="eta-type ${typeClass}">${label}</span>` +
        `<div class="eta-scenarios">` +
          scenarioRow('eta-dot-likely', 'Most likely', goalData.likely) +
          `<p class="eta-range-note">Consistent pace &mdash; keep it up!</p>` +
        `</div>` +
        `</div>`;
    }

    return `<div class="eta-goal">` +
      `<span class="eta-type ${typeClass}">${label}</span>` +
      `<div class="eta-scenarios">` +
        scenarioRow('eta-dot-best',   'Best case',   goalData.optimistic) +
        scenarioRow('eta-dot-likely', 'Most likely', goalData.likely) +
        scenarioRow('eta-dot-worst',  'Worst case',  goalData.pessimistic) +
      `</div>` +
      `</div>`;
  }

  el.innerHTML =
    goalHTML('Day', 'day-type', data.day) +
    goalHTML('Night', 'night-type', data.night) +
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

function renderTip() {
  document.getElementById('tip-text').textContent = DRIVING_TIPS[currentTipIndex];
}

function refreshTip() {
  let next;
  do { next = Math.floor(Math.random() * DRIVING_TIPS.length); } while (next === currentTipIndex);
  currentTipIndex = next;
  renderTip();
  const btn = document.querySelector('.tip-refresh-btn');
  if (btn) {
    btn.classList.remove('tip-refresh-spinning');
    void btn.offsetWidth; // force reflow so animation restarts if tapped rapidly
    btn.classList.add('tip-refresh-spinning');
    setTimeout(() => btn.classList.remove('tip-refresh-spinning'), 400);
  }
}

// ---- Render: Confidence Bars + Drift Chart ----

// Computes the weighted-4-week "most likely" completion for any session subset.
// Returns { dayDays, nightDays } — days from today, 0 if achieved, null if unprojectible.
function computeLikelyCompletion(sessSubset) {
  if (!sessSubset.length) return null;

  const totalDay   = sessSubset.reduce((s, x) => s + x.dayMinutes,   0);
  const totalNight = sessSubset.reduce((s, x) => s + x.nightMinutes, 0);

  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const todayMs = today.getTime();

  const sorted = [...sessSubset].sort((a, b) => a.date.localeCompare(b.date));
  function noon(str) { return new Date(str + 'T12:00:00').getTime(); }

  const firstMs = noon(sorted[0].date);
  const elapsed = Math.max(1, Math.round((todayMs - firstMs) / 86400000));
  const simpleDay   = totalDay   / elapsed;
  const simpleNight = totalNight / elapsed;

  function wfwRate(type) {
    let wSum = 0, wTotal = 0;
    for (let w = 0; w < 4; w++) {
      const weight  = 4 - w;
      const endMs   = todayMs - w * 7 * 86400000;
      const startMs = endMs   - 6 * 86400000;
      let sum = 0;
      for (const s of sorted) {
        const ms = noon(s.date);
        if (ms >= startMs && ms <= endMs) sum += type === 'day' ? s.dayMinutes : s.nightMinutes;
      }
      wSum += (sum / 7) * weight; wTotal += weight;
    }
    const r = wSum / wTotal;
    return r > 0 ? r : (type === 'day' ? simpleDay : simpleNight);
  }

  const remDay   = Math.max(0, DAY_TARGET_MINS   - totalDay);
  const remNight = Math.max(0, NIGHT_TARGET_MINS - totalNight);

  function toDays(rate, remaining) {
    if (remaining <= 0) return 0;
    if (rate <= 0)      return null;
    return Math.ceil(remaining / rate);
  }

  return {
    dayDays:   toDays(wfwRate('day'),   remDay),
    nightDays: toDays(wfwRate('night'), remNight),
  };
}

function renderConfidenceBars() {
  const el   = document.getElementById('eta-bars');
  const data = calculateEstimatedCompletion();

  if (!data || !data.enoughDataForRange) {
    el.innerHTML = '<p class="eta-bars-placeholder">Log more sessions to see confidence and drift data</p>';
    return;
  }

  const today = new Date();
  today.setHours(12, 0, 0, 0);

  function daysFrom(d) {
    if (!(d instanceof Date)) return 0;
    return Math.max(0, Math.round((d.getTime() - today.getTime()) / 86400000));
  }

  function barHTML(typeClass, label, color, goalData) {
    const header = `<div class="eta-bar-header">` +
      `<span class="eta-bar-type-label ${typeClass}">${label}</span>`;

    if (goalData.complete) {
      return `<div class="eta-bar-section" style="--eta-bar-color:${color}">` +
        header + `</div>` +
        `<p class="eta-bar-complete"><svg width="22" height="22" viewBox="0 0 22 22" style="vertical-align:middle;margin-right:6px" aria-hidden="true"><circle cx="11" cy="11" r="11" fill="#52b788"/><polyline points="6,11 9.5,15 16,7" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>Goal reached &#x2014; no estimate needed</p>` +
        `</div>`;
    }

    const bestDays   = daysFrom(goalData.optimistic);
    const likelyDays = daysFrom(goalData.likely);
    const worstDays  = daysFrom(goalData.pessimistic);

    if (goalData.collapsed || bestDays === worstDays) {
      return `<div class="eta-bar-section" style="--eta-bar-color:${color}">` +
        header + `<span class="eta-bar-pct">100%</span></div>` +
        `<div class="eta-bar-track">` +
          `<div class="eta-bar-fill" style="width:100%"></div>` +
          `<div class="eta-bar-dot" style="left:50%"></div>` +
        `</div>` +
        `<span class="eta-bar-sublabel">Perfect consistency!</span>` +
        `</div>`;
    }

    // Fix 1: denominator is worstDays (distance from today to worst case).
    // Example: gap=18d, worst=90d → (1 - 18/90)*100 = 80% (Tight estimate).
    //          gap=18d, worst=21d → (1 - 18/21)*100 = 14% (Uncertain).
    const gap      = worstDays - bestDays;
    const confPct  = Math.round(Math.max(0, Math.min(100,
      (1 - gap / worstDays) * 100)));
    // Fill covers 0→bestDays on the 0→worstDays track.
    const fillPct  = worstDays ? Math.round(bestDays   / worstDays * 100) : 100;
    // Fix 2: dot sits at the likelyDays position on the same 0→worstDays scale,
    // clamped so the 12px dot never overflows either edge of the track.
    const rawDotPct = worstDays ? (likelyDays / worstDays * 100) : 50;
    const dotPct   = Math.max(0, Math.min(100, rawDotPct));
    const sublabel = confPct > 70 ? 'Tight estimate' : confPct >= 40 ? 'Moderate' : 'Uncertain';

    return `<div class="eta-bar-section" style="--eta-bar-color:${color}">` +
      header + `<span class="eta-bar-pct">${confPct}%</span></div>` +
      `<div class="eta-bar-track">` +
        `<div class="eta-bar-fill" style="width:${fillPct}%"></div>` +
        `<div class="eta-bar-dot" style="left:clamp(6px,${dotPct.toFixed(1)}%,calc(100% - 6px))"></div>` +
      `</div>` +
      `<span class="eta-bar-sublabel">${sublabel}</span>` +
      `</div>`;
  }

  el.innerHTML = `<div class="eta-bars-row">` +
    barHTML('day-type',   'Day',   '#52b788', data.day) +
    barHTML('night-type', 'Night', '#0d9498', data.night) +
    `</div>`;
}

function renderDriftChart() {
  const canvas      = document.getElementById('drift-chart');
  const placeholder = document.getElementById('eta-drift-placeholder');
  const section     = document.getElementById('eta-drift-section');
  if (!canvas) return;

  const n = sessions.length;

  if (n < 3) {
    canvas.style.display = 'none';
    if (placeholder) placeholder.hidden = false;
    return;
  }

  canvas.style.display = 'block';
  if (placeholder) placeholder.hidden = true;

  const sorted = [...sessions].sort((a, b) => a.date.localeCompare(b.date));

  // One data point per cumulative session subset
  const pts = [];
  for (let i = 1; i <= n; i++) {
    const est = computeLikelyCompletion(sorted.slice(0, i));
    pts.push(est || { dayDays: null, nightDays: null });
  }

  // Canvas sizing
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.offsetWidth || (section ? section.clientWidth : 0) || 300;
  const H   = 120;
  canvas.width        = W * dpr;
  canvas.height       = H * dpr;
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const PAD_L = 42;
  const PAD_R = 12;
  const PAD_T = 20;
  const PAD_B = 18;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T  - PAD_B;

  // Y range
  const allDays = pts.flatMap(p => [p.dayDays, p.nightDays]).filter(v => v !== null);
  const maxDays = allDays.length ? Math.max(...allDays) : 100;

  function xPos(i) { // i = 0-based index
    return PAD_L + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  }

  function yPos(days) {
    if (days === null) return null;
    return PAD_T + (1 - Math.max(0, Math.min(maxDays, days)) / maxDays) * plotH;
  }

  // Resolve CSS colour variables for the current theme
  const cs        = getComputedStyle(document.documentElement);
  const colLight  = (cs.getPropertyValue('--text-light') || '#52796f').trim();
  const colBorder = (cs.getPropertyValue('--border')     || '#b7dfc4').trim();

  ctx.clearRect(0, 0, W, H);

  // Y-axis gridlines + month labels
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const today  = new Date(); today.setHours(12, 0, 0, 0);

  const rawStep    = maxDays / 4;
  const tickStep   = Math.max(7, (Math.round(rawStep / 30) || 1) * 30);

  ctx.font         = '10px system-ui,-apple-system,sans-serif';
  ctx.textBaseline = 'middle';

  for (let d = 0; d <= maxDays; d += tickStep) {
    const y = yPos(d);
    if (y === null) continue;
    const labelDate = new Date(today.getTime() + d * 86400000);
    const label     = d === 0 ? 'Now' : MONTHS[labelDate.getMonth()];

    ctx.fillStyle  = colLight;
    ctx.textAlign  = 'right';
    ctx.fillText(label, PAD_L - 5, y);

    ctx.beginPath();
    ctx.strokeStyle = colBorder;
    ctx.lineWidth   = 0.5;
    ctx.setLineDash([]);
    ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L + plotW, y);
    ctx.stroke();
  }

  // Y=0 dashed line (goal-achieved threshold)
  const y0 = yPos(0);
  if (y0 !== null) {
    ctx.beginPath();
    ctx.strokeStyle = colLight;
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 4]);
    ctx.moveTo(PAD_L, y0); ctx.lineTo(PAD_L + plotW, y0);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Data lines
  function drawLine(color, key) {
    ctx.beginPath();
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.setLineDash([]);
    let started = false;
    for (let i = 0; i < pts.length; i++) {
      const x = xPos(i);
      const y = yPos(pts[i][key]);
      if (y === null) { started = false; continue; }
      if (!started) { ctx.moveTo(x, y); started = true; }
      else           { ctx.lineTo(x, y); }
    }
    ctx.stroke();
  }

  drawLine('#52b788', 'dayDays');
  drawLine('#0d9498', 'nightDays');

  // X-axis session-number labels — enforce 28px minimum gap to prevent overlap.
  // Always show session 1 and session N; show every-5th only if it fits.
  ctx.fillStyle    = colLight;
  ctx.textBaseline = 'top';

  const MIN_LABEL_GAP = 28;
  const labelY        = H - PAD_B + 3;

  // Candidate indices: first, every-5th, last
  const candidates = new Set([0]);
  for (let i = 0; i < n; i++) { if ((i + 1) % 5 === 0) candidates.add(i); }
  candidates.add(n - 1);
  const sortedCandidates = [...candidates].sort((a, b) => a - b);

  const drawnX = []; // x-positions of labels already committed to canvas

  for (let ci = 0; ci < sortedCandidates.length; ci++) {
    const i      = sortedCandidates[ci];
    const x      = xPos(i);
    const isFirst = i === 0;
    const isLast  = i === n - 1;

    if (isFirst) {
      ctx.textAlign = 'center';
      ctx.fillText(String(i + 1), x, labelY);
      drawnX.push(x);
      continue;
    }

    if (isLast) {
      // Always draw; right-align if the label would overflow the right canvas edge
      const nearEdge = x + 10 > W - PAD_R;
      ctx.textAlign  = nearEdge ? 'right' : 'center';
      ctx.fillText(String(i + 1), nearEdge ? W - PAD_R : x, labelY);
      ctx.textAlign  = 'center';
      continue;
    }

    // Intermediate: skip if too close to the previous drawn label or to the last label
    const tooCloseLeft  = drawnX.length > 0 && x - drawnX[drawnX.length - 1] < MIN_LABEL_GAP;
    const tooCloseRight = xPos(n - 1) - x < MIN_LABEL_GAP;
    if (tooCloseLeft || tooCloseRight) continue;

    ctx.textAlign = 'center';
    ctx.fillText(String(i + 1), x, labelY);
    drawnX.push(x);
  }

  // Legend (top-right)
  const LX = W - PAD_R;
  const LY = 10;
  ctx.font         = '10px system-ui,-apple-system,sans-serif';
  ctx.textBaseline = 'middle';

  ctx.strokeStyle = '#52b788'; ctx.lineWidth = 2; ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(LX - 76, LY); ctx.lineTo(LX - 62, LY); ctx.stroke();
  ctx.fillStyle = '#52b788'; ctx.textAlign = 'left';
  ctx.fillText('Day', LX - 59, LY);

  ctx.strokeStyle = '#0d9498';
  ctx.beginPath(); ctx.moveTo(LX - 32, LY); ctx.lineTo(LX - 18, LY); ctx.stroke();
  ctx.fillStyle = '#0d9498';
  ctx.fillText('Night', LX - 15, LY);
}

function renderAll() {
  renderDashboard();
  renderStreak();
  renderMilestoneBadges();
  renderETA();
  renderConfidenceBars();
  renderDriftChart();
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

// ---- Header collapse on scroll ----

function initHeaderCollapse() {
  const heroExpanded = document.getElementById('hero-expanded');

  // The fixed header is always 56px — body has permanent padding-top: 56px to match.
  // The expanded hero section lives in the normal scroll flow below the header.
  // Toggling .collapsed on it collapses it via CSS max-height/opacity transitions
  // so the cards below slide up naturally with no layout jump anywhere.
  let ticking = false;
  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const shouldCollapse = window.scrollY > 60;
      if (heroExpanded.classList.contains('collapsed') !== shouldCollapse) {
        heroExpanded.classList.toggle('collapsed', shouldCollapse);
        heroExpanded.setAttribute('aria-hidden', shouldCollapse ? 'true' : 'false');
      }
      ticking = false;
    });
  }, { passive: true });
}

// ---- Bootstrap ----

loadSessions();
initForm();
renderAll();
renderTip();
updateAppBadge();
setTimeout(initNotifications, 5000);
initHeaderCollapse();

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

// Debugging only — call window.testUpdateToast() in the browser console to verify
// the toast UI works without needing a real service worker update. Can be removed later.
window.testUpdateToast = showUpdateToast;

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

          // Attach statechange immediately — before the worker can advance to installed
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdateToast();
            }
          });

          // Guard against the (rare) case where the worker reached installed before we attached
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateToast();
          }
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

// ---- Print Log ----

function printLog() {
  const { day, night } = getTotals();
  const total      = day + night;
  const overallPct = Math.min(100, Math.round((total / (DAY_TARGET_MINS + NIGHT_TARGET_MINS)) * 100));
  const eta        = calculateEstimatedCompletion();
  const now        = new Date();
  const dateStr    = fmtDateObj(now);
  const datetimeStr = dateStr + ' ' + now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  function etaStr() {
    if (!eta) return 'Not enough data';
    const later = eta.dayEta === 'achieved' && eta.nightEta === 'achieved' ? 'achieved' :
      [eta.dayEta, eta.nightEta]
        .filter(d => d && d !== 'achieved')
        .sort((a, b) => b - a)[0];
    if (!later) return 'Goal achieved!';
    if (later === 'achieved') return 'Goal achieved!';
    return fmtDateObj(later);
  }

  const sorted = [...sessions].sort((a, b) =>
    a.date !== b.date ? b.date.localeCompare(a.date) : b.startTime.localeCompare(a.startTime)
  );

  const supervisorStats = getSupervisorStats();

  const sessionRows = sorted.map(s => `
    <tr>
      <td>${fmtDate(s.date)}</td>
      <td>${fmtTime(s.startTime)}</td>
      <td>${fmtTime(s.endTime)}</td>
      <td>${fmtHours(s.dayMinutes)}h</td>
      <td>${fmtHours(s.nightMinutes)}h</td>
      <td>${s.supervisor || '—'}</td>
      <td>${s.location  || '—'}</td>
      <td>${s.weather}</td>
    </tr>`).join('');

  const supervisorRows = supervisorStats.map(s => `
    <tr>
      <td>${s.name}</td>
      <td>${fmtHours(s.day)}h</td>
      <td>${fmtHours(s.night)}h</td>
      <td>${fmtHours(s.total)}h</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Drive Log — Official Hours Summary</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Georgia, 'Times New Roman', serif; font-size: 12pt; color: #000; background: #fff; padding: 24pt; }
    h1 { font-size: 18pt; margin-bottom: 4pt; }
    .date { font-size: 11pt; color: #444; margin-bottom: 20pt; }
    h2 { font-size: 13pt; margin: 20pt 0 8pt; border-bottom: 1px solid #000; padding-bottom: 4pt; }
    .summary-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10pt; margin-bottom: 4pt; }
    .summary-item { border: 1px solid #ccc; padding: 8pt 10pt; }
    .summary-label { font-size: 9pt; color: #555; text-transform: uppercase; letter-spacing: 0.04em; }
    .summary-value { font-size: 15pt; font-weight: bold; margin-top: 2pt; }
    table { width: 100%; border-collapse: collapse; font-size: 10pt; }
    th { background: #f0f0f0; border: 1px solid #aaa; padding: 5pt 7pt; text-align: left; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.03em; }
    td { border: 1px solid #ccc; padding: 5pt 7pt; vertical-align: top; }
    tr:nth-child(even) td { background: #fafafa; }
    footer { margin-top: 24pt; padding-top: 8pt; border-top: 1px solid #ccc; font-size: 9pt; color: #666; }
    @media print {
      body { padding: 0; }
      @page { margin: 18mm 14mm; }
    }
  </style>
</head>
<body>
  <h1>Drive Log &mdash; Official Hours Summary</h1>
  <p class="date">${dateStr}</p>

  <h2>Summary</h2>
  <div class="summary-grid">
    <div class="summary-item">
      <div class="summary-label">Day Hours</div>
      <div class="summary-value">${fmtHours(day)}h</div>
      <div class="summary-label">of 40h goal (${Math.round((day / DAY_TARGET_MINS) * 100)}%)</div>
    </div>
    <div class="summary-item">
      <div class="summary-label">Night Hours</div>
      <div class="summary-value">${fmtHours(night)}h</div>
      <div class="summary-label">of 10h goal (${Math.round((night / NIGHT_TARGET_MINS) * 100)}%)</div>
    </div>
    <div class="summary-item">
      <div class="summary-label">Total Hours</div>
      <div class="summary-value">${fmtHours(total)}h</div>
      <div class="summary-label">of 50h goal (${overallPct}%)</div>
    </div>
    <div class="summary-item">
      <div class="summary-label">Sessions Logged</div>
      <div class="summary-value">${sessions.length}</div>
    </div>
    <div class="summary-item">
      <div class="summary-label">Day Remaining</div>
      <div class="summary-value">${fmtHours(Math.max(0, DAY_TARGET_MINS - day))}h</div>
    </div>
    <div class="summary-item">
      <div class="summary-label">Est. Completion</div>
      <div class="summary-value" style="font-size:11pt">${etaStr()}</div>
    </div>
  </div>

  <h2>Session History (${sorted.length} sessions)</h2>
  <table>
    <thead>
      <tr>
        <th>Date</th><th>Start</th><th>End</th>
        <th>Day hrs</th><th>Night hrs</th>
        <th>Supervisor</th><th>Location</th><th>Weather</th>
      </tr>
    </thead>
    <tbody>${sessionRows}</tbody>
  </table>

  <h2>Supervisor Summary</h2>
  <table>
    <thead>
      <tr><th>Supervisor</th><th>Day hrs</th><th>Night hrs</th><th>Total hrs</th></tr>
    </thead>
    <tbody>${supervisorRows}</tbody>
  </table>

  <footer>Generated by Drive Log PWA &nbsp;&mdash;&nbsp; ${datetimeStr}</footer>
</body>
</html>`;

  const win = window.open('', '_blank');
  if (!win) { alert('Please allow pop-ups to use Print Log.'); return; }
  win.document.write(html);
  win.document.close();
  win.addEventListener('load', () => win.print());
}

document.getElementById('print-btn').addEventListener('click', printLog);

// ---- QR Export ----

function showQRModal() {
  const json       = JSON.stringify(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'));
  const overlay    = document.getElementById('qr-modal-overlay');
  const canvasWrap = document.getElementById('qr-canvas-wrap');
  const tooLarge   = document.getElementById('qr-too-large');
  const copyBtn    = document.getElementById('qr-copy-btn');

  canvasWrap.innerHTML = '';
  overlay.removeAttribute('hidden');

  if (json.length > 2000) {
    canvasWrap.hidden = true;
    tooLarge.hidden   = false;
    copyBtn.hidden    = true;
  } else {
    canvasWrap.hidden = false;
    tooLarge.hidden   = true;
    copyBtn.hidden    = false;
    new QRCode(canvasWrap, {
      text:         json,
      width:        256,
      height:       256,
      colorDark:    '#000000',
      colorLight:   '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });
  }
}

function closeQRModal() {
  document.getElementById('qr-modal-overlay').setAttribute('hidden', '');
}

function copyQRJSON() {
  const json = JSON.stringify(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'), null, 2);
  navigator.clipboard.writeText(json).then(() => {
    const btn  = document.getElementById('qr-copy-btn');
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  }).catch(() => {
    alert('Could not copy to clipboard — please use the Export button instead.');
  });
}

document.getElementById('qr-btn')?.addEventListener('click', showQRModal);

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
