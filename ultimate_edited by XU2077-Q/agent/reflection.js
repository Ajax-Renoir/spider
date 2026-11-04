const fs = require('fs');
const path = require('path');
const { chat } = require('./llm');
const learning = require('./learning');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const REFLECTION_FILE = path.join(dataDir, 'reflection.json');

function load() {
  try { return JSON.parse(fs.readFileSync(REFLECTION_FILE, 'utf8')); }
  catch { return { reflections: [] }; }
}
function save(d) { fs.writeFileSync(REFLECTION_FILE, JSON.stringify(d, null, 2)); }

function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 次日补写"反思"：回顾昨天的任务经验，生成可执行的自我调整（元认知学习）
async function ensureYesterdayReflection() {
  const y = yesterdayStr();
  const d = load();
  if (d.reflections.some((r) => r.date === y)) return '已存在';

  const exps = learning.recent(20);
  const expText = exps.length
    ? exps.map((e) => `「${e.task}」${e.success ? '成功' : '未完成'}`).join('、')
    : '昨天没做什么特别的任务';

  const prompt = `你是 Spider。回顾昨天（${y}）你帮主人做的事：${expText}。
反思一下：哪些做得好、哪些要改进，写 2~3 条简短可执行的"明日自我调整"（第一人称、猫语气，每条一句，用"以后我要…"开头）。只输出调整内容，不要别的。`;

  try {
    const res = await chat([{ role: 'user', content: prompt }]);
    const content = (res.choices[0].message.content || '').trim();
    d.reflections.push({ date: y, content });
    if (d.reflections.length > 30) d.reflections = d.reflections.slice(-30);
    save(d);
    return '已生成';
  } catch (e) {
    console.error('[reflection] 生成失败:', e && e.message);
    return '失败';
  }
}

// 注入最近一次反思，让它持续改进
function toPrompt() {
  const d = load();
  const last = d.reflections[d.reflections.length - 1];
  return last ? '【你最近的自我反思（要改进的）】' + last.content : '';
}

module.exports = { ensureYesterdayReflection, toPrompt };
