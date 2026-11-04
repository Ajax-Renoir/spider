const { app, BrowserWindow, screen, ipcMain, powerMonitor, Notification } = require('electron');
const path = require('path');
const agent = require('./agent/agent');
const tools = require('./agent/tools');
const vitals = require('./agent/vitals');
const diary = require('./agent/diary');
const habits = require('./agent/habits');
const perception = require('./agent/perception');
const reflection = require('./agent/reflection');
const autonomy = require('./agent/autonomy');

let petWindow = null;
let chatWindow = null;
let diaryWindow = null;
let dragOffset = null;
let isDragging = false;
const PET_WIDTH = 260;
const PET_HEIGHT = 220;

const clampNum = (v, a, b) => Math.max(a, Math.min(b, v));

function createPetWindow() {
  const { workArea } = screen.getPrimaryDisplay();

  petWindow = new BrowserWindow({
    width: PET_WIDTH,
    height: PET_HEIGHT,
    x: workArea.x + workArea.width - PET_WIDTH - 30,
    y: workArea.y + workArea.height - PET_HEIGHT - 30,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  petWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  petWindow.on('closed', () => { petWindow = null; });
}

function createChatWindow() {
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.focus();
    return;
  }
  chatWindow = new BrowserWindow({
    width: 380,
    height: 560,
    title: 'Spider',
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  chatWindow.loadFile(path.join(__dirname, 'renderer', 'chat.html'));
  chatWindow.on('closed', () => { chatWindow = null; });
}

// —— 平滑移动窗口（宠物走路用）——
function moveWindowTo(win, x, y, duration) {
  const [sx, sy] = win.getPosition();
  const dx = x - sx, dy = y - sy;
  if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
  duration = duration || 700;
  const start = Date.now();
  function step() {
    const t = Math.min(1, (Date.now() - start) / duration);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
    win.setPosition(Math.round(sx + dx * e), Math.round(sy + dy * e));
    if (t < 1) setTimeout(step, 16);
  }
  step();
}

// 给宠物窗发动画信号
function petAnim(type) {
  if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('pet-anim', type);
}

// Spider 说话：优先在宠物窗显示漫画气泡，窗口未就绪时退回系统通知
function petSpeak(text) {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet-speak', text);
  } else if (Notification.isSupported()) {
    new Notification({ title: 'Spider', body: text }).show();
  }
}

// —— 随机行为引擎：让它"活着"，不是贴纸 ——
function startWander() {
  setInterval(() => {
    if (!petWindow || petWindow.isDestroyed() || isDragging) return;
    const { workArea } = screen.getPrimaryDisplay();
    const [x, y] = petWindow.getPosition();
    const r = Math.random();

    if (r < 0.45) {
      // 走路：移动到附近随机位置
      const nx = Math.round(clampNum(x + (Math.random() * 160 - 80), workArea.x, workArea.x + workArea.width - PET_WIDTH));
      const ny = Math.round(clampNum(y + (Math.random() * 30 - 15), workArea.y, workArea.y + workArea.height - PET_HEIGHT));
      petAnim(nx < x ? 'walk-left' : 'walk-right');
      moveWindowTo(petWindow, nx, ny, 700);
      setTimeout(() => petAnim('idle'), 750);
    } else if (r < 0.65) {
      // 蹦一下
      petAnim('hop');
      setTimeout(() => petAnim('idle'), 550);
    }
    // 其余时间待机呼吸
  }, 5000 + Math.random() * 4000);
}

function createDiaryWindow() {
  if (diaryWindow && !diaryWindow.isDestroyed()) { diaryWindow.focus(); return; }
  diaryWindow = new BrowserWindow({
    width: 560, height: 640,
    title: 'Spider 的漫画日记',
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  diaryWindow.loadFile(path.join(__dirname, 'renderer', 'diary.html'));
  diaryWindow.on('closed', () => { diaryWindow = null; });
}

// —— 拖拽（宠物窗）——
ipcMain.on('drag-start', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const cursor = screen.getCursorScreenPoint();
  const [wx, wy] = win.getPosition();
  dragOffset = { x: cursor.x - wx, y: cursor.y - wy };
  isDragging = true;
});
ipcMain.on('drag-move', (e) => {
  if (!dragOffset) return;
  const win = BrowserWindow.fromWebContents(e.sender);
  const cursor = screen.getCursorScreenPoint();
  win.setPosition(cursor.x - dragOffset.x, cursor.y - dragOffset.y);
});
ipcMain.on('drag-end', () => { dragOffset = null; isDragging = false; });

// 宠物窗随气泡内容增高（底部对齐，向上生长）
ipcMain.on('pet-resize', (e, { height }) => {
  if (!petWindow || petWindow.isDestroyed()) return;
  const [x, y] = petWindow.getPosition();
  const cur = petWindow.getSize();
  const h = Math.max(180, Math.min(Math.round(height || PET_HEIGHT), 520));
  const newY = y + cur[1] - h;
  petWindow.setBounds({ x, y: newY, width: PET_WIDTH, height: h });
});

// —— 打开聊天 ——
ipcMain.on('open-chat', () => createChatWindow());

// —— 日记 ——
ipcMain.on('open-diary', () => createDiaryWindow());
ipcMain.handle('diary-list', () => diary.list());
ipcMain.handle('diary-read', (e, date) => diary.read(date));

// —— 聊天 ——
ipcMain.handle('agent-chat', async (e, { msg, history, chatId }) => {
  try {
    const reply = await agent.runAgent(msg, history || [], (chunk) => {
      if (chatId && e.sender && !e.sender.isDestroyed()) e.sender.send('agent-chat-delta', { chatId, chunk });
    });
    petSpeak(reply);
    return { ok: true, reply };
  } catch (err) {
    console.error('[agent-chat] 出错:', err && err.stack ? err.stack : err);
    return { ok: false, error: err.message };
  }
});

// —— 生理状态（养成互动）——
function vitalsView(v) {
  const e = vitals.getEmotion(v);
  return { energy: Math.round(v.energy), satiety: Math.round(v.satiety), mood: Math.round(v.mood), sleeping: v.sleeping, emotion: e, emotionLabel: vitals.EMOTIONS[e] };
}
ipcMain.handle('vitals-get', () => vitalsView(vitals.tick()));
ipcMain.handle('vitals-feed', () => { petAnim('happy'); vitals.feed(); return vitalsView(vitals.tick()); });
ipcMain.handle('vitals-pet', () => { petAnim('happy'); vitals.pet(); return vitalsView(vitals.tick()); });
ipcMain.handle('vitals-play', () => { petAnim('happy'); vitals.play(); return vitalsView(vitals.tick()); });
ipcMain.handle('vitals-wake', () => vitalsView(vitals.wake()));

// —— 调试：演示主动触发 ——
ipcMain.handle('debug-fire', async (e, type) => {
  const msg = await autonomy.debugFire(type);
  if (msg) petSpeak(msg);
  return msg;
});

app.whenReady().then(() => {
  tools.restoreReminders();
  createPetWindow();
  startWander();
  diary.ensureYesterdayDiary().then((r) => console.log('[diary]', r));
  reflection.ensureYesterdayReflection().then((r) => console.log('[reflection]', r));

  // 主动触发：启动问候 + 周期检查
  autonomy.greet().then(petSpeak).catch((e) => console.error('[greet]', e && e.message));
  setInterval(() => {
    try {
      const idleSec = powerMonitor.getSystemIdleTime();
      perception.update(idleSec);           // 情绪感知：忙/空闲/离开
      if (idleSec < 90) habits.markActive(); // 习惯学习：记录用户活跃时段
      autonomy.onMinute(idleSec).then((m) => { if (m) { petSpeak(m); petAnim('happy'); } }).catch((e) => console.error('[autonomy]', e && e.message));
    } catch (e) {}
  }, 60 * 1000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createPetWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
