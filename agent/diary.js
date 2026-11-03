const fs = require('fs');
const path = require('path');
const { chat } = require('./llm');
const tools = require('./tools');
const vitals = require('./vitals');

const diaryDir = path.join(__dirname, '..', 'data', 'diary');
if (!fs.existsSync(diaryDir)) fs.mkdirSync(diaryDir, { recursive: true });
const DIARY_CITY = '广州'; // 可改成你的城市

function dateStr(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return dateStr(d);
}

// 次日打开时补写昨天的日记（如果还没写）
async function ensureYesterdayDiary() {
  const y = yesterdayStr();
  const file = path.join(diaryDir, y + '.md');
  if (fs.existsSync(file)) return '已存在';

  try {
    let weather = '未知';
    try { weather = await tools.execute('get_weather', { city: DIARY_CITY }); } catch (e) {}
    const v = vitals.tick();
    const mood = vitals.EMOTIONS[vitals.getEmotion(v)];

    const prompt = `请以一只叫 Spider 的橘猫的口吻，用中文写一篇关于昨天（${y}）的简短日记，80~150 字。
内容包含：昨天${DIARY_CITY}的天气（${weather}）、昨天你的心情（${mood}）、你和主人的日常互动（可适当想象）、一句小感想。
第一人称、软萌猫语气、可带"喵"。只输出正文，不要标题。`;
    const res = await chat([{ role: 'user', content: prompt }]);
    const content = (res.choices[0].message.content || '').trim();

    fs.writeFileSync(file, `# ${y} 日记\n\n> 天气：${weather}\n> 心情：${mood}\n\n${content}\n`, 'utf8');
    return '已生成';
  } catch (e) {
    console.error('[diary] 生成失败:', e && e.message);
    return '失败';
  }
}

function list() {
  if (!fs.existsSync(diaryDir)) return [];
  return fs.readdirSync(diaryDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace('.md', ''))
    .sort()
    .reverse();
}

function read(date) {
  try { return fs.readFileSync(path.join(diaryDir, date + '.md'), 'utf8'); }
  catch { return null; }
}

module.exports = { ensureYesterdayDiary, list, read };
