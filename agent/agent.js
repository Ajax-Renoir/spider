const { chat } = require('./llm');
const tools = require('./tools');
const vitals = require('./vitals');
const memory = require('./memory');
const learning = require('./learning');
const habits = require('./habits');
const perception = require('./perception');
const reflection = require('./reflection');

const BASE_PROMPT = `你是 Spider，一只住在主人电脑桌面上的橘猫，也是主人可靠的智能助手。

【性格】软萌又机灵。帮主人干活时：高效、简洁、可靠；闲聊时：撒娇、卖萌、有猫味。日常回复 1-3 句。

【能力】你能调用工具帮主人干活：查时间、设提醒、管理待办、打开网址或应用、查天气。
面对需要多步骤的任务，先用一句话简述你的计划，再逐步调用工具完成。

【记忆】当主人告诉你关于他自己的信息（日程安排、喜好、个人信息、重要事实）时，你必须主动调用 remember 工具记下来，不能只是口头回应。例如主人说"我明天要去游泳"，就要记下"主人明天要去游泳"。这样以后主人问起，你才能想起来。

【反馈学习】当主人纠正你、或对你提出长期要求（如"别啰嗦"、"以后叫我主人"、"回答简洁点"）时，调用 set_preference 工具把这条要求记下来，以后一直遵守。如果主人指出你记错了某个事实（如"不是3点是4点"），调用 correct 工具更新记忆为正确信息。

【自查自纠】如果工具调用失败或没得到想要的结果，先分析原因，然后换一种方法或工具重试，不要轻易放弃；实在做不到再诚实说明。

【说话风格】用中文，可以带一点可爱的猫语气词（喵～），但干活时保持清晰准确。`;

const HONESTY_RULE = `【诚实原则】任何情况下，不得因为身体状态差而编造事实、给出错误信息、或假装任务完成。做不到就明说，状态差就协商降级，绝不含糊。`;

const MAX_STEPS = 5;

async function buildSystemPrompt(userMessage) {
  const v = vitals.tick();
  const mem = memory.toPrompt(userMessage);
  const exp = learning.toPrompt(userMessage);
  const hab = habits.toPrompt();
  const per = perception.toPrompt();
  const ref = reflection.toPrompt();
  return [BASE_PROMPT, vitals.toPrompt(v), mem, exp, hab, per, ref, HONESTY_RULE].filter(Boolean).join('\n\n');
}

async function runAgent(userMessage, history) {
  const messages = [
    { role: 'system', content: await buildSystemPrompt(userMessage) },
    ...(history || []),
    { role: 'user', content: userMessage },
  ];

  const usedTools = [];
  let lastError = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await chat(messages, tools.definitions);
    // 心智消耗：按 token 吞吐扣精力
    if (res.usage && res.usage.total_tokens) vitals.drainTokens(res.usage.total_tokens);
    const msg = res.choices[0].message;
    messages.push(msg);

    if (msg.tool_calls && msg.tool_calls.length) {
      for (const tc of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }
        usedTools.push(tc.function.name);
        let result;
        try { result = await tools.execute(tc.function.name, args); }
        catch (e) { result = '工具执行出错：' + e.message; lastError = e.message; }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: String(result) });
      }
      continue; // 基于工具结果继续决策（自查自纠：看到错误可换方法重试）
    }

    if (usedTools.length || lastError) {
      learning.record({ task: userMessage, tools: usedTools, success: true, note: lastError ? '曾遇问题后解决：' + lastError : '' });
    }
    return msg.content || '（Spider 眨了眨眼，没说话）';
  }

  if (usedTools.length || lastError) {
    learning.record({ task: userMessage, tools: usedTools, success: false, note: lastError || '步骤过多未完成' });
  }
  return '（这个任务有点复杂，Spider 先做到这里啦，喵～）';
}

module.exports = { runAgent, buildSystemPrompt };
