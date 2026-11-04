const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const MEMORY_FILE = path.join(dataDir, 'memory.json');

function load() {
  try { return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); }
  catch { return { facts: [], preferences: [] }; }
}
function save(m) { fs.writeFileSync(MEMORY_FILE, JSON.stringify(m, null, 2)); }

// 记住一件事实（主人告诉你关于他自己的信息）
function remember(text, tags) {
  const m = load();
  m.facts.push({ text, tags: tags || [], createdAt: Date.now() });
  save(m);
  return `已记住：${text}`;
}

// 记住一条长期偏好/要求（主人纠正你、提出行为要求时）
function addPreference(text) {
  const m = load();
  m.preferences = m.preferences || [];
  m.preferences.push({ text, createdAt: Date.now() });
  save(m);
  return `已记住偏好：${text}`;
}

// 纠错：主人纠正你记错的信息时，更新记忆为正确内容
function correct(oldText, newText) {
  const m = load();
  const idx = m.facts.findIndex((f) => f.text.includes(oldText));
  if (idx >= 0) m.facts[idx] = { text: newText, tags: m.facts[idx].tags || [], createdAt: Date.now() };
  else m.facts.push({ text: newText, tags: [], createdAt: Date.now() });
  save(m);
  return `已更正：${newText}`;
}

function bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

function recall(query, k) {
  const m = load();
  if (!query || !m.facts.length) return [];
  const qChars = new Set(query.split(''));
  const qb = bigrams(query);
  const scored = m.facts
    .map((f) => {
      let score = 0;
      for (const t of f.tags || []) {
        if (query.includes(t)) score += 4;
        else if (t.length >= 2 && [...t].some((c) => qChars.has(c))) score += 2;
      }
      const fb = bigrams(f.text);
      for (const b of qb) if (fb.has(b)) score += 1;
      const days = (Date.now() - f.createdAt) / 86400000;
      score *= 1 / (1 + days * 0.1);
      return { text: f.text, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k || 3);
  return scored.map((x) => x.text);
}

// 生成注入 prompt 的记忆块：偏好（永远注入）+ 相关事实（按需召回）
function toPrompt(query) {
  const m = load();
  const facts = recall(query, 3);
  const parts = [];
  if ((m.preferences || []).length) parts.push('【主人对你的长期要求/偏好】' + m.preferences.map((p) => p.text).join('；'));
  if (facts.length) parts.push('【你记住的关于主人的事】' + facts.join('；'));
  return parts.join('\n');
}

module.exports = { remember, addPreference, correct, recall, toPrompt };
