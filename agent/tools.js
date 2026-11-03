const { shell, Notification, clipboard } = require('electron');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const memory = require('./memory');

// 数据目录（待办、提醒都持久化在这里，已 gitignore）
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const REMINDERS_FILE = path.join(dataDir, 'reminders.json');
const TODOS_FILE = path.join(dataDir, 'todos.json');
const WORKSPACE_DIR = path.join(dataDir, 'workspace'); // 文件读写默认工作区

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ================= 工具定义（给 LLM 看的 JSON Schema） =================
const definitions = [
  {
    type: 'function',
    function: {
      name: 'get_time',
      description: '获取当前日期和时间',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_reminder',
      description: '设置一个提醒，到点后桌面会弹出通知',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '提醒内容' },
          time: { type: 'string', description: '提醒时间，格式 YYYY-MM-DD HH:mm 或 HH:mm' },
          repeat: { type: 'string', enum: ['none', 'daily', 'weekly'], description: '是否重复，默认 none' },
        },
        required: ['text', 'time'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_todo',
      description: '添加一条待办事项',
      parameters: { type: 'object', properties: { text: { type: 'string', description: '待办内容' } }, required: ['text'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_todo',
      description: '列出所有待办事项',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'complete_todo',
      description: '完成一条待办（按序号）',
      parameters: { type: 'object', properties: { id: { type: 'integer', description: '待办序号' } }, required: ['id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: '用默认浏览器打开一个网址',
      parameters: { type: 'object', properties: { url: { type: 'string', description: '网址' } }, required: ['url'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_app',
      description: '打开一个应用程序或文件',
      parameters: { type: 'object', properties: { name: { type: 'string', description: '应用名或文件路径' } }, required: ['name'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '查询指定城市的当前天气',
      parameters: { type: 'object', properties: { city: { type: 'string', description: '城市名，如 北京' } }, required: ['city'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description: '记住关于主人的一件事（当主人说"记住…"或你发现值得记的重要信息时使用）',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要记住的内容' },
          tags: { type: 'array', items: { type: 'string' }, description: '关键词标签，便于日后回忆' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_preference',
      description: '记录主人对你的长期要求或偏好（当主人纠正你、或说"别…"/"以后…"/"我喜欢…"这类要求时使用）',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '要长期遵守的要求/偏好' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'correct',
      description: '主人指出你记错了某个事实时，把记忆更新为正确信息（如"不是3点，是4点"）',
      parameters: {
        type: 'object',
        properties: {
          old_text: { type: 'string', description: '之前记错的内容（可模糊匹配）' },
          new_text: { type: 'string', description: '正确的信息' },
        },
        required: ['new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_reminders',
      description: '列出所有已设置的提醒',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_reminder',
      description: '取消一条提醒（按序号）',
      parameters: { type: 'object', properties: { id: { type: 'integer', description: '提醒序号' } }, required: ['id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取一个文本文件的内容（写绝对路径，或 桌面/xxx.txt、下载/xxx.txt 这类位置）',
      parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径，如 桌面/周记.txt 或 D:/xxx.txt' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '把内容写成一个文本文件（写笔记、周记、报告等）',
      parameters: { type: 'object', properties: {
        path: { type: 'string', description: '保存路径，如 桌面/周记.txt' },
        content: { type: 'string', description: '要写入的完整内容' },
      }, required: ['path', 'content'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列出一个目录下的文件（默认工作区，可给 桌面/下载/文档 等位置）',
      parameters: { type: 'object', properties: { path: { type: 'string', description: '目录路径，可省略' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_clipboard',
      description: '读取剪贴板里的文本',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_clipboard',
      description: '把文本写入剪贴板，方便主人直接粘贴',
      parameters: { type: 'object', properties: { text: { type: 'string', description: '要复制的文本' } }, required: ['text'] },
    },
  },
];

// ================= 工具实现 =================
function get_time() {
  return new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}

// —— 天气 ——
const WMO = { 0: '晴朗', 1: '基本晴朗', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇', 51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 61: '小雨', 63: '中雨', 65: '大雨', 71: '小雪', 73: '中雪', 75: '大雪', 80: '阵雨', 81: '阵雨', 82: '强阵雨', 95: '雷雨', 96: '雷雨冰雹', 99: '雷雨冰雹' };

async function get_weather({ city }) {
  const geo = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`);
  const geoData = await geo.json();
  if (!geoData.results || !geoData.results.length) return `没找到「${city}」`;
  const r = geoData.results[0];
  const w = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${r.latitude}&longitude=${r.longitude}&current_weather=true`);
  const wd = await w.json();
  const cw = wd.current_weather;
  const desc = WMO[cw.weathercode] || `天气代码 ${cw.weathercode}`;
  return `${r.name} 当前 ${cw.temperature}°C，${desc}，风速 ${cw.windspeed} km/h`;
}

// —— 提醒 ——
const scheduled = {};
function schedule(reminder) {
  if (reminder.done) return;
  const delay = new Date(reminder.time).getTime() - Date.now();
  if (delay <= 0) return;
  if (scheduled[reminder.id]) clearTimeout(scheduled[reminder.id]);
  scheduled[reminder.id] = setTimeout(() => {
    if (Notification.isSupported()) {
      new Notification({ title: 'Spider 提醒', body: reminder.text }).show();
    }
    reminder.done = true;
    const list = readJson(REMINDERS_FILE, []).map((r) => (r.id === reminder.id ? reminder : r));
    writeJson(REMINDERS_FILE, list);
  }, delay);
}

function set_reminder({ text, time, repeat }) {
  const reminders = readJson(REMINDERS_FILE, []);
  let when = new Date(time);
  if (isNaN(when.getTime())) {
    const [h, m] = time.split(':').map(Number);
    if (isNaN(h) || isNaN(m)) return '时间格式不对，请用 YYYY-MM-DD HH:mm 或 HH:mm';
    when = new Date();
    when.setHours(h, m, 0, 0);
    if (when.getTime() < Date.now()) when.setDate(when.getDate() + 1);
  }
  const r = { id: Date.now(), text, time: when.toISOString(), repeat: repeat || 'none', done: false };
  reminders.push(r);
  writeJson(REMINDERS_FILE, reminders);
  schedule(r);
  return `已设提醒：${text}（${when.toLocaleString('zh-CN', { hour12: false })}）`;
}

function restoreReminders() {
  readJson(REMINDERS_FILE, []).forEach(schedule);
}

// —— 待办 ——
function add_todo({ text }) {
  const todos = readJson(TODOS_FILE, []);
  todos.push({ id: todos.length + 1, text, done: false });
  writeJson(TODOS_FILE, todos);
  return `已添加待办 #${todos.length}：${text}`;
}
function list_todo() {
  const todos = readJson(TODOS_FILE, []);
  if (!todos.length) return '当前没有待办';
  return todos.map((t) => `${t.done ? '✅' : '⬜'} #${t.id} ${t.text}`).join('\n');
}
function complete_todo({ id }) {
  const todos = readJson(TODOS_FILE, []);
  const t = todos.find((x) => x.id === id);
  if (!t) return `没有 #${id} 这条待办`;
  t.done = true;
  writeJson(TODOS_FILE, todos);
  return `已完成 #${id}：${t.text}`;
}

// —— 打开 ——
async function open_url({ url }) {
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  await shell.openExternal(url);
  return `已打开 ${url}`;
}
async function open_app({ name }) {
  const apps = { 记事本: 'notepad', notepad: 'notepad', 计算器: 'calc', calc: 'calc', 画图: 'mspaint', mspaint: 'mspaint' };
  const cmd = apps[name.toLowerCase()] || apps[name];
  if (cmd) {
    exec(cmd);
    return `已打开 ${name}`;
  }
  const err = await shell.openPath(name);
  return err ? `打不开 ${name}` : `已打开 ${name}`;
}

// —— 记忆 ——
function remember(args) { return memory.remember(args.text, args.tags); }
function set_preference(args) { return memory.addPreference(args.text); }
function correct(args) { return memory.correct(args.old_text || '', args.new_text); }

// —— 提醒列表 / 取消 ——
function list_reminders() {
  const reminders = readJson(REMINDERS_FILE, []);
  if (!reminders.length) return '当前没有提醒';
  return reminders.map((r, i) => `${r.done ? '✅' : '⏰'} #${i + 1} ${r.text}（${new Date(r.time).toLocaleString('zh-CN', { hour12: false })}）`).join('\n');
}
function cancel_reminder({ id }) {
  const reminders = readJson(REMINDERS_FILE, []);
  const idx = id - 1;
  if (idx < 0 || idx >= reminders.length) return `没有 #${id} 这条提醒`;
  const [r] = reminders.splice(idx, 1);
  if (scheduled[r.id]) clearTimeout(scheduled[r.id]);
  writeJson(REMINDERS_FILE, reminders);
  return `已取消提醒：${r.text}`;
}

// —— 文件读写 / 剪贴板 ——
function resolvePath(p) {
  if (!p) return WORKSPACE_DIR;
  const home = os.homedir();
  const map = {
    '桌面': path.join(home, 'Desktop'),
    '下载': path.join(home, 'Downloads'),
    '文档': path.join(home, 'Documents'),
    '工作区': WORKSPACE_DIR,
  };
  for (const k of Object.keys(map)) {
    if (p === k) return map[k];
    if (p.startsWith(k + '/') || p.startsWith(k + '\\')) return path.join(map[k], p.slice(k.length + 1));
  }
  return path.isAbsolute(p) ? p : path.join(WORKSPACE_DIR, p);
}
function read_file({ path: p }) {
  const fp = resolvePath(p);
  try {
    const s = fs.readFileSync(fp, 'utf8');
    return s.length > 8000 ? s.slice(0, 8000) + '\n…（内容过长已截断）' : s;
  } catch (e) { return `读不到文件 ${fp}：${e.message}`; }
}
function write_file({ path: p, content }) {
  const fp = resolvePath(p);
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, 'utf8');
    return `已写入 ${fp}`;
  } catch (e) { return `写入失败 ${fp}：${e.message}`; }
}
function list_dir({ path: p }) {
  const fp = resolvePath(p);
  try {
    const items = fs.readdirSync(fp, { withFileTypes: true });
    if (!items.length) return `${fp} 是空目录`;
    return items.map((it) => (it.isDirectory() ? '[目录] ' : '') + it.name).join('\n');
  } catch (e) { return `列不出目录 ${fp}：${e.message}`; }
}
function get_clipboard() {
  try { return clipboard.readText() || '（剪贴板为空）'; }
  catch (e) { return `读不到剪贴板：${e.message}`; }
}
function set_clipboard({ text }) {
  try { clipboard.writeText(String(text)); return '已复制到剪贴板'; }
  catch (e) { return `写入剪贴板失败：${e.message}`; }
}

// —— 分发 ——
const handlers = { get_time, set_reminder, add_todo, list_todo, complete_todo, open_url, open_app, get_weather, remember, set_preference, correct, list_reminders, cancel_reminder, read_file, write_file, list_dir, get_clipboard, set_clipboard };
async function execute(name, args) {
  const fn = handlers[name];
  if (!fn) return `没有「${name}」这个工具`;
  return await fn(args || {});
}

module.exports = { definitions, execute, restoreReminders };
