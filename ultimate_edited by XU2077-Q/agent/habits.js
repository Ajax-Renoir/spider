const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const HABITS_FILE = path.join(dataDir, 'habits.json');

function load() {
  try { return JSON.parse(fs.readFileSync(HABITS_FILE, 'utf8')); }
  catch { return { days: {} }; }
}
function save(d) { fs.writeFileSync(HABITS_FILE, JSON.stringify(d, null, 2)); }

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 记录"用户此刻正在活动"（主进程周期性调用）
function markActive() {
  const d = load();
  const today = todayStr();
  if (!d.days[today]) d.days[today] = { firstActive: null, hours: {} };
  const day = d.days[today];
  if (!day.firstActive) day.firstActive = new Date().toISOString();
  day.hours[new Date().getHours()] = true;
  save(d);
}

// 从历史天数推导习惯
function summarize() {
  const d = load();
  const days = Object.keys(d.days);
  if (days.length < 1) return null;
  let firstSum = 0, firstN = 0;
  for (const k of days) {
    const f = d.days[k].firstActive;
    if (f) { firstSum += new Date(f).getHours(); firstN++; }
  }
  const parts = [];
  if (firstN) parts.push(`主人通常在 ${Math.round(firstSum / firstN)} 点左右开始用电脑`);
  return parts.length ? parts.join('；') : null;
}

function toPrompt() {
  const s = summarize();
  return s ? '【你摸清的主人作息习惯】' + s : '';
}

module.exports = { markActive, summarize, toPrompt };
