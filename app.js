'use strict';

const STORAGE_KEY      = 'drivingLogSessions';
const DAY_TARGET_MINS  = 40 * 60;
const NIGHT_TARGET_MINS = 10 * 60;

let sessions  = [];
let editingId = null;

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

// ---- Render: Dashboard ----

function renderDashboard() {
  const { day, night } = getTotals();
  const total = day + night;

  const dayPct     = Math.min(100, (day   / DAY_TARGET_MINS)   * 100);
  const nightPct   = Math.min(100, (night / NIGHT_TARGET_MINS) * 100);
  const overallPct = Math.min(100, (total / (DAY_TARGET_MINS + NIGHT_TARGET_MINS)) * 100);

  document.getElementById('day-bar').style.width    = dayPct + '%';
  document.getElementById('day-logged').textContent    = fmtHours(day);
  document.getElementById('day-remaining').textContent = fmtHours(Math.max(0, DAY_TARGET_MINS - day));
  document.getElementById('day-pct').textContent       = Math.round(dayPct) + '%';

  document.getElementById('night-bar').style.width      = nightPct + '%';
  document.getElementById('night-logged').textContent    = fmtHours(night);
  document.getElementById('night-remaining').textContent = fmtHours(Math.max(0, NIGHT_TARGET_MINS - night));
  document.getElementById('night-pct').textContent       = Math.round(nightPct) + '%';

  document.getElementById('overall-pct').textContent = Math.round(overallPct) + '%';
}

// ---- Render: Session History ----

function renderHistory() {
  const el = document.getElementById('session-list');
  if (!sessions.length) {
    el.innerHTML = '<p class="empty-state">No sessions logged yet. Add your first drive above!</p>';
    return;
  }

  const sorted = [...sessions].sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    return b.startTime.localeCompare(a.startTime);
  });

  el.innerHTML = sorted.map(s => {
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
  }).join('');
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

  document.getElementById('session-form').scrollIntoView({ behavior: 'smooth' });
}

function deleteSession(id) {
  if (!confirm('Delete this session? This cannot be undone.')) return;
  sessions = sessions.filter(s => s.id !== id);
  saveSessions();
  renderAll();
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

// ---- Bootstrap ----

loadSessions();
initForm();
renderAll();
