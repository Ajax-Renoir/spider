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

module.exports = { chat };
