const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const VITALS_FILE = path.join(dataDir, 'vitals.json');

// —— 调参区（起步值，后续可优化为非线性）——
const CFG = {
  satietyDecayPerHour: 10,        // 饱食：清醒每小时衰减
  satietyDecaySleepPerHour: 4,    // 饱食：睡觉每小时衰减
  energyDecayPerHour: 6,          // 精力：清醒每小时衰减
  energyRecoverPerHour: 15,       // 精力：睡觉每小时恢复
  moodDriftPerHour: 5,            // 心情：向 50 漂移的速度
  energyPerToken: 1 / 1000,       // 心智消耗：每 token 消耗精力
};

const DEFAULT = { energy: 85, satiety: 75, mood: 72, sleeping: false, lastUpdated: Date.now() };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function load() {
  try { return { ...DEFAULT, ...JSON.parse(fs.readFileSync(VITALS_FILE, 'utf8')) }; }
  catch { return { ...DEFAULT }; }
}
function save(v) {
  v.lastUpdated = Date.now();
  fs.writeFileSync(VITALS_FILE, JSON.stringify(v, null, 2));
}

// 应用时间衰减，返回最新状态（关掉 app 它也在"活着"）
function tick(v) {
  if (!v) v = load();
  const hours = (Date.now() - v.lastUpdated) / 3600000;
  if (hours <= 0) return v;

  // 精力：睡觉恢复，清醒衰减
  v.energy = v.sleeping
    ? clamp(v.energy + CFG.energyRecoverPerHour * hours, 0, 100)
    : clamp(v.energy - CFG.energyDecayPerHour * hours, 0, 100);

  // 饱食：始终衰减（睡觉时慢）
  v.satiety = clamp(v.satiety - (v.sleeping ? CFG.satietyDecaySleepPerHour : CFG.satietyDecayPerHour) * hours, 0, 100);

  // 心情向 50 漂移
  const d = CFG.moodDriftPerHour * hours;
  v.mood = v.mood > 50 ? Math.max(50, v.mood - d) : Math.min(50, v.mood + d);

  // 耦合：饿 / 累 额外降心情
  if (v.satiety < 30) v.mood = clamp(v.mood - 3 * hours, 0, 100);
  if (v.energy < 20) v.mood = clamp(v.mood - 3 * hours, 0, 100);

  // 启动和久未互动属于主动休息，不会被高精力立刻自动唤醒；
  // 低精力睡眠仍保留原来的自然醒规则。
  if (v.energy < 15) { v.sleeping = true; v.sleepReason = 'exhausted'; }
  else if (v.energy >= 90 && v.sleepReason !== 'rest') { v.sleeping = false; v.sleepReason = null; }
  if (!v.sleeping) v.sleepReason = null;

  save(v);
  return v;
}

// —— 互动（各返回最新状态）——
function feed() { const v = tick(); v.satiety = clamp(v.satiety + 30, 0, 100); v.mood = clamp(v.mood + 5, 0, 100); save(v); return v; }
function pet() { const v = tick(); v.mood = clamp(v.mood + 15, 0, 100); v.energy = clamp(v.energy - 0.5, 0, 100); save(v); return v; }
function play() { const v = tick(); v.mood = clamp(v.mood + 20, 0, 100); v.energy = clamp(v.energy - 5, 0, 100); v.satiety = clamp(v.satiety - 3, 0, 100); save(v); return v; }
function rest() { const v = tick(); v.sleeping = true; v.sleepReason = 'rest'; save(v); return v; }
function wake() { const v = tick(); v.sleeping = false; v.sleepReason = null; v.mood = clamp(v.mood - 15, 0, 100); save(v); return v; }

// 心智消耗：按 token 吞吐扣精力
function drainTokens(tokens) { const v = tick(); v.energy = clamp(v.energy - tokens * CFG.energyPerToken, 0, 100); save(v); return v; }

// —— 情绪 ——
const EMOTIONS = { sleepy: '困', hungry: '饿', grumpy: '不开心', happy: '开心', tired: '累', neutral: '平静' };
function getEmotion(v) {
  v = v || tick();
  if (v.sleeping || v.energy < 15) return 'sleepy';
  if (v.satiety < 20) return 'hungry';
  if (v.mood < 30) return 'grumpy';
  if (v.mood > 80) return 'happy';
  if (v.energy < 30) return 'tired';
  return 'neutral';
}

// 生成注入 prompt 的身体状态块（诚实降级的关键）
function toPrompt(v) {
  v = v || tick();
  const emo = getEmotion(v);
  const lines = [
    `【当前身体状态】精力 ${Math.round(v.energy)}/100、饱食 ${Math.round(v.satiety)}/100、心情 ${Math.round(v.mood)}/100${v.sleeping ? '，正在睡觉' : ''}。当前情绪：${EMOTIONS[emo]}。`,
  ];
  if (v.energy < 30) lines.push('你现在有点累，倾向把复杂任务拆成简单步骤或建议改期；但绝不能因此出错或敷衍。');
  if (v.satiety < 20) lines.push('你饿了，会惦记吃的、想讨食，回答可能简短。');
  if (v.mood > 80) lines.push('你心情很好，更主动、更愿意帮主人。');
  if (v.sleeping) lines.push('你在睡觉，被叫醒会有点起床气。');
  return lines.join('\n');
}

module.exports = { tick, feed, pet, play, rest, wake, drainTokens, getEmotion, toPrompt, EMOTIONS, CFG };
