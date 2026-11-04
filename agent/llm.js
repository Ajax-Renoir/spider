const config = require('./config');

// 调用 DeepSeek（OpenAI 兼容），支持 function calling
async function chat(messages, tools) {
  const body = { model: config.deepseek.model, messages };
  if (tools && tools.length) body.tools = tools;

  const res = await fetch(`${config.deepseek.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.deepseek.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM 调用失败 (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

// 流式调用（SSE）：逐段回调 onDelta，返回与 chat 相同的结果结构
async function chatStream(messages, tools, onDelta) {
  const body = { model: config.deepseek.model, messages, stream: true, stream_options: { include_usage: true } };
  if (tools && tools.length) body.tools = tools;

  const res = await fetch(`${config.deepseek.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.deepseek.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM 调用失败 (${res.status}): ${text.slice(0, 300)}`);
  }

  let content = '';
  const toolCalls = new Map(); // index -> { id, name, arguments }
  let usage = null;
  const decoder = new TextDecoder();
  let buf = '';

  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      if (json.usage) usage = json.usage;
      const delta = json.choices && json.choices[0] && json.choices[0].delta;
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
        if (onDelta) onDelta(delta.content);
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index || 0;
          if (!toolCalls.has(idx)) toolCalls.set(idx, { id: '', name: '', arguments: '' });
          const cur = toolCalls.get(idx);
          if (tc.id) cur.id = tc.id;
          if (tc.function) {
            if (tc.function.name) cur.name += tc.function.name;
            if (tc.function.arguments) cur.arguments += tc.function.arguments;
          }
        }
      }
    }
  }

  const tool_calls = [...toolCalls.values()].map((t) => ({
    id: t.id, type: 'function',
    function: { name: t.name, arguments: t.arguments || '{}' },
  }));

  return {
    choices: [{ message: { role: 'assistant', content, tool_calls: tool_calls.length ? tool_calls : undefined } }],
    usage,
  };
}

module.exports = { chat, chatStream };
