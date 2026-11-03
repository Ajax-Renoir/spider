const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const LEARNING_FILE = path.join(dataDir, 'learning.json');

function load() {
  try { return JSON.parse(fs.readFileSync(LEARNING_FILE, 'utf8')); }
  catch { return { experiences: [] }; }
}
function save(d) { fs.writeFileSync(LEARNING_FILE, JSON.stringify(d, null, 2)); }

// 记录一次任务经验：用了哪些工具、成败、备注（是否遇到问题）
function record({ task, tools, success, note }) {
  const d = load();
  d.experiences.push({ task, tools: tools || [], success, note: note || '', createdAt: Date.now() });
  if (d.experiences.length > 200) d.experiences = d.experiences.slice(-200);
  save(d);
}

function bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

// 按当前任务召回相似的历史经验（工具名命中权重高 + 文本 2-gram 重叠 + 时间衰减）
function recall(task, k) {
  const d = load();
  if (!task || !d.experiences.length) return [];
  const qb = bigrams(task);
  const scored = d.experiences
    .map((e) => {
      const eb = bigrams(e.task + ' ' + (e.tools || []).join(' '));
      let score = 0;
      for (const b of qb) if (eb.has(b)) score += 1;
      for (const t of e.tools || []) if (task.includes(t)) score += 2;
      const days = (Date.now() - e.createdAt) / 86400000;
      score *= 1 / (1 + days * 0.1);
      return { e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k || 3);
  return scored.map((x) => x.e);
}

// 生成注入 prompt 的经验块：让 agent 从过去的做法里学习
function toPrompt(task) {
  const exps = recall(task, 3);
  if (!exps.length) return '';
  const lines = exps.map((e) => {
    const tools = (e.tools || []).length ? `，用了工具 [${e.tools.join(', ')}]` : '';
    const status = e.success ? '成功' : '未完成';
    return `- 任务「${e.task}」${status}${tools}${e.note ? '（' + e.note + '）' : ''}`;
  });
  return '【你过去的任务经验】\n' + lines.join('\n');
}

// 最近 N 条任务经验（反思用）
function recent(n) {
  const d = load();
  return d.experiences.slice(-(n || 20));
}

module.exports = { record, recall, recent, toPrompt };
