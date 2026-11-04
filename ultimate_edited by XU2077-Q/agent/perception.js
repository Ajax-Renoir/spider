// 用户状态感知：忙 / 空闲 / 离开（由主进程按系统空闲时间周期性更新）
let state = 'unknown';

function update(idleSec) {
  if (idleSec < 30) state = 'busy';        // 正在活跃打字/操作
  else if (idleSec < 300) state = 'free';  // 空闲
  else state = 'away';                     // 离开电脑
}

function getState() { return state; }

function toPrompt() {
  const map = {
    busy: '主人现在正忙，你要安静一点、回复简短，别打扰他',
    free: '主人现在有空，你可以活泼一点、主动找他玩',
    away: '主人现在不在电脑前',
  };
  const t = map[state];
  return t ? '【你感知到的主人当前状态】' + t : '';
}

module.exports = { update, getState, toPrompt };
