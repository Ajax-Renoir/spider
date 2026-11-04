const { chat } = require('./llm');
const vitals = require('./vitals');

// 冷却状态（进程内，避免重复打扰）
const cooldowns = {};
let activeSince = null;

function canFire(key, ms) {
  const now = Date.now();
  if (cooldowns[key] && now - cooldowns[key] < ms) return false;
  cooldowns[key] = now;
  return true;
}

// LLM 生成 Spider 主动要说的话
async function speak(situation) {
  const prompt = `你是 Spider，一只橘猫。现在你要主动对主人说话（不是回应，是主动发起）。情境：${situation}。
用 Spider 的口吻说 1~2 句，中文，软萌直接，可带"喵"。只输出要说的话。`;
  const res = await chat([{ role: 'user', content: prompt }]);
  return (res.choices[0].message.content || '').trim();
}

// 启动问候（按时间段）
async function greet() {
  const hour = new Date().getHours();
  const s = hour < 11 ? '现在是早上，主人刚打开电脑，你道早安，并问要不要安排今天的事'
    : hour < 18 ? '现在是白天，主人刚打开电脑，你打个招呼，问今天要不要帮忙'
    : '现在是晚上，主人刚打开电脑，你打个招呼，提醒别太晚睡';
  return await speak(s);
}

// 周期性检查，命中返回动作类型和主动消息，否则 null
async function check(idleSec) {
  const v = vitals.tick();
  const hour = new Date().getHours();
  const active = idleSec < 90; // 用户正在用电脑

  // 饥饿讨食
  if (v.satiety < 20 && canFire('hungry', 30 * 60000)) {
    return { type: 'hungry', text: await speak('你饿得不行（饱食度很低），向主人撒娇讨食') };
  }
  // 无聊求陪（主人离开 + 心情低）
  if (v.mood < 30 && idleSec > 300 && canFire('bored', 30 * 60000)) {
    return { type: 'bored', text: await speak('主人好久没理你，你有点无聊失落，想引起他注意') };
  }
  // 深夜提醒
  if (active && (hour >= 23 || hour < 2) && canFire('latenight', 60 * 60000)) {
    return { type: 'latenight', text: await speak('已经深夜，主人还在忙，你提醒他该睡觉了') };
  }
  // 饭点提醒
  if (active && (hour === 12 || hour === 18) && canFire('meal', 60 * 60000)) {
    return { type: 'meal', text: await speak('到了饭点，主人还在忙，你提醒他该吃饭了') };
  }
  // 过劳提醒（连续活跃 2 小时）
  if (active) {
    if (!activeSince) activeSince = Date.now();
    if (Date.now() - activeSince > 2 * 60 * 60000 && canFire('overwork', 30 * 60000)) {
      return { type: 'overwork', text: await speak('主人已经连续工作 2 小时了，你提醒他起来活动 5 分钟') };
    }
  } else {
    activeSince = null;
  }

  return null;
}

// 调试：直接触发某条主动消息（演示用，绕过条件/冷却）
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

module.exports = { greet, check, debugFire };
