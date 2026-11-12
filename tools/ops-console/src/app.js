import { api, config, getSession, setSession } from './api.js';
import { badge, errorBox, field, h, mount } from './ui.js';
import { configView } from './views/config.js';
import { gachaView } from './views/gacha.js';
import { eventsView } from './views/events.js';
import { playersView } from './views/players.js';
import { compensationsView } from './views/compensations.js';
import { auditView } from './views/audit.js';
import { kpiView } from './views/kpi.js';
import { maintenanceView } from './views/maintenance.js';
import { inquiriesView } from './views/inquiries.js';
import { clientErrorsView } from './views/clientErrors.js';
import { releaseNotesView } from './views/releaseNotes.js';
import { calendarView } from './views/calendar.js';
import { surveysView } from './views/surveys.js';

const views = { config: configView, gacha: gachaView, events: eventsView, players: playersView, compensations: compensationsView, inquiries: inquiriesView, 'client-errors': clientErrorsView, surveys: surveysView, audit: auditView, kpi: kpiView, maintenance: maintenanceView, calendar: calendarView, 'release-notes': releaseNotesView };
const main = document.getElementById('main');
const nav = document.getElementById('nav');
const who = document.getElementById('who');
const logout = document.getElementById('logout');

const envBadge = document.getElementById('env-badge');
envBadge.textContent = config.envLabel;
envBadge.className = `env-badge env-${config.envLabel}`;

function loginView() {
  nav.hidden = true; logout.hidden = true; mount(who);
  const base = h('input', { type: 'url', value: config.apiBase || location.origin, 'data-testid': 'login-base', autocomplete: 'off', spellcheck: 'false' });
  const token = h('input', { type: 'password', autocomplete: 'off', placeholder: '管理トークン（ADMIN_TOKENS の平文）', 'data-testid': 'login-token' });
  const out = h('div');
  const form = h('form', { class: 'login', onsubmit: async (e) => {
    e.preventDefault();
    mount(out);
    const apiBase = base.value.replace(/\/+$/, '');
    try {
      const me = await api('GET', '/v1/admin/whoami', undefined, { token: token.value, base: apiBase });
      setSession({ token: token.value, apiBase, id: me.id, role: me.role, via: me.via });
      token.value = '';
      if (!location.hash || location.hash === '#/login') location.hash = '#/config'; // hashchange renders it
      else route();
    } catch (err) {
      mount(out, errorBox(err));
    }
  } },
  h('h1', {}, 'ログイン'),
  h('p', { class: 'muted' }, '管理APIのトークンでログインします。トークンはこのタブの sessionStorage にだけ保存され、タブを閉じると消えます。Cloudflare Access 経由の場合も、トークンは別途必要です。'),
  field('API', base), field('トークン', token),
  h('button', { class: 'btn primary', type: 'submit', 'data-testid': 'login-submit' }, 'ログイン'), out);
  mount(main, form);
  token.focus();
}

let renderSeq = 0;
async function route() {
  const s = getSession();
  if (!s) { loginView(); return; }
  nav.hidden = false; logout.hidden = false;
  mount(who, h('span', { class: 'who-id' }, s.id), ' ', badge(s.role, `role-${s.role}`), ' ', h('span', { class: 'muted small' }, s.apiBase || 'same origin'));
  const name = (location.hash.replace(/^#\/?/, '').split('/')[0]) || 'config';
  const view = views[name] ?? views.config;
  for (const a of nav.querySelectorAll('a')) a.classList.toggle('active', a.dataset.view === name);
  // each render draws into its own container and only the latest one is attached (no stale render overwrites a newer one)
  const seq = ++renderSeq;
  const box = h('div', { class: 'view' }, h('div', { class: 'loading' }, '読み込み中…'));
  mount(main, box);
  try {
    await view(box, location.hash.split('/').slice(2).map(decodeURIComponent));
  } catch (e) {
    if (seq === renderSeq) mount(box, errorBox(e));
  }
  main.focus({ preventScroll: true });
}

logout.addEventListener('click', () => { setSession(null); location.hash = '#/login'; loginView(); });
window.addEventListener('hashchange', route);
window.addEventListener('ops:signed-out', () => loginView());
route();
