const fs = require('fs');
const path = require('path');

// 读取 config.local.json（含 key，已被 .gitignore 隔离，不进入公开仓库）
const configPath = path.join(__dirname, '..', 'config.local.json');
const config = {
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: '' },
  weather: { provider: 'open-meteo' },
};
try {
  const raw = fs.readFileSync(configPath, 'utf8');
  Object.assign(config, JSON.parse(raw));
} catch (e) {
  // 没有配置文件则使用默认空 key
}

module.exports = config;
