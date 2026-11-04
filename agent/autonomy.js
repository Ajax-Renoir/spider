const fs = require('fs');
const path = require('path');
const { chat } = require('./llm');
const tools = require('./tools');
const vitals = require('./vitals');
const memory = require('./memory');
const habits = require('./habits');
const perception = require('./perception');

// 自主行动记录（打扰预算、冷却、今日次数）持久化
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const AUTONOMY_FILE = path.join(dataDir, 'autonomy.json');

// —— 动作白名单：只允许只读 + 低风险可逆写（不可逆/扰民的一律不进）——
const ALLOWED_TOOLS = new Set(['get_time', 'get_weather', 'list_todo', 'add_todo', 'set_reminder']);

const MAX_PER_DAY = 12;           // 每日主动打扰上限
const GLOBAL_MIN_GAP = 8 * 60000; // 两次主动发言最小间隔 8 分钟
const REASON_COOLDOWNS = {        // 各唤醒原因的冷却时间
  hungry: 30 * 60000,
  bored: 30 * 60000,
  overwork: 30 * 60000,
  meal: 60 * 60000,
  latenight: 60 * 60000,
  return: 10 * 60000,
};

const REASON_TEXT = {
  hungry: '你饿了',
  bored: '你有点无聊 / 主人好久没理你',
  overwork: '主人连续工作很久了',
  meal: '到饭点了',
  latenight: '深夜了',
  return: '主人回到电脑前了',
};

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function load() {
  try { return JSON.parse(fs.readFileSync(AUTONOMY_FILE, 'utf8')); }
  catch { return { date: '', count: 0, cooldowns: {}, lastAt: 0 }; }
}
function save(d) { fs.writeFileSync(AUTONOMY_FILE, JSON.stringify(d, null, 2)); }

// 打扰预算 + 冷却：不满足就返回 null（本次不打扰）
function gate(reason) {
  const d = load();
  const t = todayStr();
  if (d.date !== t) { d.date = t; d.count = 0; d.cooldowns = {}; }
  if (d.count >= MAX_PER_DAY) { save(d); return null; }
  const now = Date.now();
  if (now - d.lastAt < GLOBAL_MIN_GAP) { save(d); return null; }
  const cd = (REASON_COOLDOWNS[reason] || 30 * 60000);
  if (d.cooldowns[reason] && now - d.cooldowns[reason] < cd) { save(d); return null; }
  return d;
}
function mark(d, reason) {
  d.count += 1;
  d.cooldowns[reason] = Date.now();
  d.lastAt = Date.now();
  save(d);
}

// 情境快照：身体（驱动源）+ 时间 + 主人状态 + 记忆 + 习惯 + 待办
async function buildSnapshot(reason) {
  const v = vitals.tick();
  const now = new Date();
  const wk = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
  const time = `${now.getMonth() + 1}月${now.getDate()}日 ${wk} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const emo = vitals.EMOTIONS[vitals.getEmotion(v)];
  const PER = { busy: '正忙', free: '空闲', away: '离开', unknown: '未知' };
  const lines = [
    `【唤醒原因】${REASON_TEXT[reason] || reason}`,
    `【当前时间】${time}`,
    `【你的身体】精力 ${Math.round(v.energy)}、饱食 ${Math.round(v.satiety)}、心情 ${Math.round(v.mood)}，情绪=${emo}${v.sleeping ? '（在睡觉）' : ''}`,
    `【主人状态】${PER[perception.getState()] || '未知'}`,
  ];
  const todos = await tools.execute('list_todo', {});
  if (todos && todos !== '当前没有待办') lines.push(`【待办】${todos}`);
  const mem = memory.recall(`${reason} 现在 今天 明天`, 3).join('；');
  if (mem) lines.push(`【你记得的事】${mem}`);
  const hab = habits.summarize();
  if (hab) lines.push(`【主人作息】${hab}`);
  return lines.join('\n');
}

const DECIDE_PROMPT = `现在你是主动模式：不是回应主人，而是你自己决定要不要做点什么。根据下面的情境快照，判断现在有没有值得主动为/对主人做的事。

规则：
- 如果没有必要，只输出两个字：静默
- 如果只想说句话（关心/提醒/撒娇），直接输出那句话（1~2 句，中文，可带喵）
- 如果想做事（设提醒、加待办、查天气），调用对应工具

注意：
- 主人正忙或离开时，除非很重要，否则保持静默
- 别重复之前说过的话，别频繁打扰
- 身体状态差时只做最必要的事，绝不硬撑`;

// 收尾：把"主动做了一件事"翻译成一句自然的话告诉主人
async function closingLine(results) {
  const prompt = `你刚才主动帮主人做了一件事，结果：${results.join('；')}。用 Spider 的口吻用 1 句话自然地把这件事告诉主人（例如"我帮你设好了提醒""我查了下天气"），中文，可带喵，只输出这句话。`;
  try {
    const res = await chat([{ role: 'user', content: prompt }]);
    return (res.choices[0].message.content || '').trim();
  } catch (e) {
    return results[0] || '我帮你办好了～';
  }
}

// 一次自主决策：返回要展示的话，或 null（静默）
async function tick(reason) {
  const d = gate(reason);
  if (!d) return null;

  const snapshot = await buildSnapshot(reason);
  const defs = tools.definitions.filter((t) => ALLOWED_TOOLS.has(t.function.name));

  let res;
  try {
    res = await chat([{ role: 'system', content: DECIDE_PROMPT }, { role: 'user', content: snapshot }], defs);
  } catch (e) {
    console.error('[autonomy] LLM 调用失败:', e && e.message);
    return null;
  }
  if (res.usage && res.usage.total_tokens) vitals.drainTokens(res.usage.total_tokens);

  const msg = res.choices[0].message;
  const content = (msg.content || '').trim();
  const calls = (msg.tool_calls || []).filter((tc) => ALLOWED_TOOLS.has(tc.function.name));

  // 有允许的工具调用 → 执行，再生成自然收尾
  if (calls.length) {
    const results = [];
    for (const tc of calls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }
      try { results.push(await tools.execute(tc.function.name, args)); }
      catch (e) { results.push(`${tc.function.name} 执行出错：${e.message}`); }
    }
    console.log('[autonomy] 主动行动:', reason, '→', calls.map((c) => c.function.name).join(','));
    mark(d, reason);
    return await closingLine(results);
  }

  // 无工具调用：静默 or 说话
  if (!content || content.replace(/\s/g, '') === '静默') return null;
  console.log('[autonomy] 主动发言:', reason, '→', content.slice(0, 40));
  mark(d, reason);
  return content;
}

// 每分钟巡检：纯 JS 判断是否有唤醒理由，命中才调 LLM（省钱）
let lastAway = false;
let activeSince = null;
function onMinute(idleSec) {
  const v = vitals.tick();
  const hour = new Date().getHours();
  const active = idleSec < 90;   // 正在用电脑
  const away = idleSec >= 300;   // 离开电脑

  let reason = null;

  // 主人回来（离开 → 活跃）
  if (lastAway && !away) reason = 'return';
  lastAway = away;

  if (!reason && v.satiety < 20) reason = 'hungry';
  if (!reason && v.mood < 30 && away) reason = 'bored';
  if (!reason && active && (hour >= 23 || hour < 2)) reason = 'latenight';
  if (!reason && active && (hour === 12 || hour === 18)) reason = 'meal';

  // 过劳：连续活跃 2 小时
  if (active) { if (!activeSince) activeSince = Date.now(); }
  else activeSince = null;
  if (!reason && active && activeSince && Date.now() - activeSince > 2 * 60 * 60000) reason = 'overwork';

  if (!reason) return Promise.resolve(null);
  return tick(reason);
}

// —— 启动问候 / 调试触发（从 triggers.js 迁移）——
async function speak(situation) {
  const prompt = `你是 Spider，一只橘猫。现在你要主动对主人说话（不是回应，是主动发起）。情境：${situation}。
用 Spider 的口吻说 1~2 句，中文，软萌直接，可带"喵"，但少用叠词、亲昵有节制。只输出要说的话。`;
  const res = await chat([{ role: 'user', content: prompt }]);
  return (res.choices[0].message.content || '').trim();
}
async function greet() {
  const hour = new Date().getHours();
  const s = hour < 11 ? '现在是早上，主人刚打开电脑，你道早安，并问要不要安排今天的事'
    : hour < 18 ? '现在是白天，主人刚打开电脑，你打个招呼，问今天要不要帮忙'
    : '现在是晚上，主人刚打开电脑，你打个招呼，提醒别太晚睡';
  return await speak(s);
}
async function debugFire(type) {
  const situations = {
    hungry: '你饿得不行（饱食度很低），向主人撒娇讨食',
    bored: '主人好久没理你，你有点无聊失落，想引起他注意',
    latenight: '已经深夜，主人还在忙，你提醒他该睡觉了',
    meal: '到了饭点，主人还在忙，你提醒他该吃饭了',
    overwork: '主人已经连续工作很久了，你提醒他起来活动 5 分钟',
  };
  if (!situations[type]) return null;
  return await speak(situations[type]);
}

module.exports = { onMinute, tick, greet, debugFire };
