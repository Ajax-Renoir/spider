const { app, BrowserWindow, screen, ipcMain, powerMonitor, Notification } = require('electron');
const path = require('path');
const agent = require('./agent/agent');
const tools = require('./agent/tools');
const vitals = require('./agent/vitals');
const diary = require('./agent/diary');
const triggers = require('./agent/triggers');
const habits = require('./agent/habits');
const perception = require('./agent/perception');
const reflection = require('./agent/reflection');

let petWindow = null;
let chatWindow = null;
let diaryWindow = null;
let dragOffset = null;
let isDragging = false;
let catHovered = false;
let currentVitals = null;
let currentAnimation = 'idle';
let sentAnimation = null;
let sentGaze = null;
let currentGaze = 'center';
let workingCount = 0;
let oneShot = null;
let oneShotTimer = null;
let roam = null;
let nextRoamTimer = null;
let gazeTimer = null;
let lastInteractionAt = Date.now();
const PET_WIDTH = 520;
const PET_HEIGHT = 440;
const ROAM_SPEED = 58;
const INACTIVITY_SLEEP_MS = Math.max(1000, Number(process.env.SPIDER_INACTIVITY_SLEEP_MS) || 10 * 60 * 1000);
const ONE_SHOT_DURATION = {
  eat: 2400, pet: 2400, play: 2800, wake: 1800, stretch: 2800,
  hop: 1200, happy: 1600, beg: 2600, attention: 2600, yawn: 2800, 'remind-meal': 2400,
};
const TRIGGER_ANIMATION = {
  hungry: 'beg', bored: 'attention', latenight: 'yawn', meal: 'remind-meal', overwork: 'stretch',
};

const clampNum = (v, a, b) => Math.max(a, Math.min(b, v));

// Windows 高 DPI 下反复 setPosition 会累积尺寸舍入误差；移动时明确保持窗口大小。
function movePetWindow(x, y) {
  if (!petWindow || petWindow.isDestroyed()) return;
  petWindow.setBounds({
    x: Math.round(x), y: Math.round(y),
    width: PET_WIDTH, height: PET_HEIGHT,
  });
}

// 透明窗口默认让点击穿透；forward 保留 hover 检测，猫身才恢复鼠标捕获。
function applyPetHitTest() {
  if (!petWindow || petWindow.isDestroyed()) return;
  petWindow.setIgnoreMouseEvents(!isDragging && !catHovered, { forward: true });
}

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

  catHovered = false;
  applyPetHitTest();
  petWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  petWindow.webContents.on('did-finish-load', () => {
    sentAnimation = null;
    sentGaze = null;
    syncPetAnimation(true);
    petGaze(currentGaze, true);
  });
  petWindow.on('blur', () => { if (isDragging) finishDrag(); });
  petWindow.on('closed', () => {
    stopRoam();
    clearTimeout(nextRoamTimer);
    nextRoamTimer = null;
    dragOffset = null;
    isDragging = false;
    catHovered = false;
    petWindow = null;
  });
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

// —— 权威动画状态：拖动 > 单次互动 > 工作 > 睡眠 > 散步 > 情绪 ——
function resolvePetAnimation() {
  if (isDragging) return 'struggle';
  if (oneShot) return oneShot.name;
  if (workingCount > 0) return 'work';
  if (currentVitals && currentVitals.sleeping) return 'sleep';
  if (roam) return roam.direction === 'left' ? 'walk-left' : 'walk-right';
  const emotion = currentVitals ? vitals.getEmotion(currentVitals) : 'neutral';
  return emotion === 'neutral' ? 'idle' : `emotion-${emotion}`;
}

function syncPetAnimation(force = false) {
  petAnim(resolvePetAnimation(), force);
}

function roamingAllowed() {
  return Boolean(
    petWindow && !petWindow.isDestroyed()
    && !isDragging && workingCount === 0 && !oneShot
    && currentVitals && !currentVitals.sleeping
  );
}

function stopRoam() {
  if (!roam) return;
  clearInterval(roam.timer);
  roam = null;
}

function clearScheduledRoam() {
  clearTimeout(nextRoamTimer);
  nextRoamTimer = null;
}

function scheduleRoam(delay = 3000 + Math.random() * 4000) {
  if (nextRoamTimer || roam || !roamingAllowed()) return;
  nextRoamTimer = setTimeout(() => {
    nextRoamTimer = null;
    startRoam();
  }, delay);
}

function reconcilePet() {
  if (!roamingAllowed()) {
    stopRoam();
    clearScheduledRoam();
  }
  syncPetAnimation();
  if (!roam) scheduleRoam();
}

// —— 短距离自主散步：窗口按真实时间匀速移动，可随时取消 ——
function startRoam() {
  if (!roamingAllowed() || roam) return;
  clearScheduledRoam();
  const { workArea } = screen.getDisplayMatching(petWindow.getBounds());
  const [x, y] = petWindow.getPosition();
  const minX = Math.round(workArea.x);
  const minY = Math.round(workArea.y);
  // 1px 余量容纳 Windows DIP 与物理像素之间的尺寸舍入。
  const maxX = Math.floor(workArea.x + workArea.width - PET_WIDTH - 1);
  const maxY = Math.floor(workArea.y + workArea.height - PET_HEIGHT - 1);
  const targetX = Math.round(clampNum(x + (Math.random() * 360 - 180), minX, maxX));
  const targetY = Math.round(clampNum(y + (Math.random() * 100 - 50), minY, maxY));
  const distance = Math.hypot(targetX - x, targetY - y);
  if (distance < 8) {
    scheduleRoam(1200);
    return;
  }

  const active = {
    targetX, targetY,
    direction: targetX < x ? 'left' : 'right',
    lastTime: Date.now(),
    timer: null,
  };
  roam = active;
  active.timer = setInterval(() => stepRoam(active), 16);
  syncPetAnimation();
}

function stepRoam(active) {
  if (roam !== active) return;
  if (!roamingAllowed()) {
    reconcilePet();
    return;
  }
  const now = Date.now();
  const elapsed = Math.max(0, (now - active.lastTime) / 1000);
  active.lastTime = now;
  const [x, y] = petWindow.getPosition();
  const dx = active.targetX - x;
  const dy = active.targetY - y;
  const distance = Math.hypot(dx, dy);
  const travel = ROAM_SPEED * elapsed;
  if (distance <= travel + 0.5) {
    movePetWindow(active.targetX, active.targetY);
    stopRoam();
    reconcilePet();
    return;
  }
  movePetWindow(
    Math.round(x + dx / distance * travel),
    Math.round(y + dy / distance * travel),
  );
}

function playOneShot(name) {
  if (!Object.hasOwn(ONE_SHOT_DURATION, name)) return;
  stopRoam();
  clearScheduledRoam();
  clearTimeout(oneShotTimer);
  oneShot = { name };
  syncPetAnimation(true);
  oneShotTimer = setTimeout(() => {
    oneShot = null;
    oneShotTimer = null;
    reconcilePet();
  }, ONE_SHOT_DURATION[name]);
}

function noteInteraction() {
  lastInteractionAt = Date.now();
}

function restAfterInactivity() {
  if (!currentVitals || currentVitals.sleeping || isDragging || workingCount > 0 || oneShot) return;
  if (Date.now() - lastInteractionAt < INACTIVITY_SLEEP_MS) return;
  updateVitals(vitals.rest());
}

function playTriggerAnimation(type) {
  if (Object.hasOwn(TRIGGER_ANIMATION, type)) playOneShot(TRIGGER_ANIMATION[type]);
}

// 只向 renderer 发送离散方向，不暴露原始鼠标坐标。
const GAZE_DIRECTIONS = [
  'right', 'down-right', 'down', 'down-left',
  'left', 'up-left', 'up', 'up-right',
];
const GAZE_POSES = new Set(['center']);
for (const direction of GAZE_DIRECTIONS) {
  GAZE_POSES.add(direction);
  GAZE_POSES.add(direction + '-near');
  GAZE_POSES.add(direction + '-mid');
}

function gazeDirection(cursor) {
  const bounds = petWindow.getBounds();
  const dx = cursor.x - (bounds.x + bounds.width * 0.46);
  const dy = cursor.y - (bounds.y + bounds.height - 96);
  const distance = Math.hypot(dx, dy);
  const centerThreshold = currentGaze === 'center' ? 34 : 24;
  if (distance < centerThreshold) return 'center';
  const nearThreshold = currentGaze.endsWith('-near') ? 132 : 112;
  const midThreshold = currentGaze.endsWith('-mid') ? 240 : 220;
  const suffix = distance < nearThreshold ? '-near' : distance < midThreshold ? '-mid' : '';
  const sector = (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8;
  return GAZE_DIRECTIONS[sector] + suffix;
}

function startGazeTracking() {
  if (gazeTimer) return;
  gazeTimer = setInterval(() => {
    if (!petWindow || petWindow.isDestroyed()) {
      petGaze('center');
      return;
    }
    petGaze(gazeDirection(screen.getCursorScreenPoint()));
  }, 32);
}

// 给宠物窗发权威动画信号，renderer 重载后强制补发。
function petAnim(type, force = false) {
  currentAnimation = type;
  if (petWindow && !petWindow.isDestroyed() && (force || sentAnimation !== type)) {
    petWindow.webContents.send('pet-anim', type);
    sentAnimation = type;
  }
}

function petGaze(direction, force = false) {
  if (!GAZE_POSES.has(direction)) return;
  currentGaze = direction;
  if (petWindow && !petWindow.isDestroyed() && (force || sentGaze !== direction)) {
    petWindow.webContents.send('pet-gaze', direction);
    sentGaze = direction;
  }
}

// Spider 说话：优先在宠物窗显示漫画气泡，窗口未就绪时退回系统通知
function petSpeak(text) {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet-speak', text);
  } else if (Notification.isSupported()) {
    new Notification({ title: 'Spider', body: text }).show();
  }
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

// —— 拖拽（宠物窗）：立即取消自主行为，所有退出路径统一清理 ——
ipcMain.on('pet-hit-test', (e, hovered) => {
  if (BrowserWindow.fromWebContents(e.sender) !== petWindow || typeof hovered !== 'boolean') return;
  catHovered = hovered;
  applyPetHitTest();
});
ipcMain.on('drag-start', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!petWindow || win !== petWindow) return;
  const cursor = screen.getCursorScreenPoint();
  const [wx, wy] = win.getPosition();
  noteInteraction();
  stopRoam();
  clearScheduledRoam();
  clearTimeout(oneShotTimer);
  oneShotTimer = null;
  oneShot = null;
  dragOffset = { x: cursor.x - wx, y: cursor.y - wy };
  isDragging = true;
  reconcilePet();
});
ipcMain.on('drag-move', (e) => {
  if (!dragOffset || !isDragging) return;
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!petWindow || win !== petWindow) return;
  const cursor = screen.getCursorScreenPoint();
  movePetWindow(cursor.x - dragOffset.x, cursor.y - dragOffset.y);
});
function finishDrag() {
  if (!isDragging && !dragOffset) return;
  dragOffset = null;
  isDragging = false;
  reconcilePet();
}
ipcMain.on('drag-end', (e) => {
  if (BrowserWindow.fromWebContents(e.sender) === petWindow) finishDrag();
});

// —— 打开聊天 ——
ipcMain.on('open-chat', () => { noteInteraction(); createChatWindow(); });

// —— 日记 ——
ipcMain.on('open-diary', () => createDiaryWindow());
ipcMain.handle('diary-list', () => diary.list());
ipcMain.handle('diary-read', (e, date) => diary.read(date));

// —— 聊天 ——
ipcMain.handle('agent-chat', async (e, { msg, history }) => {
  noteInteraction();
  workingCount += 1;
  reconcilePet();
  try {
    const reply = await agent.runAgent(msg, history || []);
    petSpeak(reply);
    return { ok: true, reply };
  } catch (err) {
    console.error('[agent-chat] 出错:', err && err.stack ? err.stack : err);
    return { ok: false, error: err.message };
  } finally {
    workingCount = Math.max(0, workingCount - 1);
    reconcilePet();
  }
});

// —— 生理状态（养成互动）——
function vitalsView(v) {
  const e = vitals.getEmotion(v);
  return { energy: Math.round(v.energy), satiety: Math.round(v.satiety), mood: Math.round(v.mood), sleeping: v.sleeping, emotion: e, emotionLabel: vitals.EMOTIONS[e] };
}
function updateVitals(next, wakeAnimation = 'wake') {
  const wasSleeping = currentVitals ? currentVitals.sleeping : null;
  currentVitals = next;
  if (wasSleeping === true && !next.sleeping && wakeAnimation) playOneShot(wakeAnimation);
  else reconcilePet();
  return vitalsView(next);
}
ipcMain.handle('vitals-get', () => updateVitals(vitals.tick()));
ipcMain.handle('vitals-feed', () => {
  noteInteraction();
  vitals.feed();
  const view = updateVitals(vitals.tick());
  playOneShot('eat');
  return view;
});
ipcMain.handle('vitals-pet', () => {
  noteInteraction();
  vitals.pet();
  const view = updateVitals(vitals.tick());
  playOneShot('pet');
  return view;
});
ipcMain.handle('vitals-play', () => {
  noteInteraction();
  vitals.play();
  const view = updateVitals(vitals.tick());
  playOneShot('play');
  return view;
});
ipcMain.handle('vitals-wake', () => {
  noteInteraction();
  const view = updateVitals(vitals.wake(), null);
  playOneShot('stretch');
  return view;
});

// —— 调试：演示主动触发 ——
ipcMain.handle('debug-fire', async (e, type) => {
  noteInteraction();
  playTriggerAnimation(type);
  const msg = await triggers.debugFire(type);
  if (msg) petSpeak(msg);
  return msg;
});

app.whenReady().then(() => {
  tools.restoreReminders();
  currentVitals = vitals.rest();
  createPetWindow();
  reconcilePet();
  startGazeTracking();
  // vitals.tick() 会写文件；低频刷新，不与高频目光更新混用。
  setInterval(() => {
    try {
      updateVitals(vitals.tick());
      restAfterInactivity();
    } catch (e) { console.error('[vitals]', e && e.message); }
  }, 1500);
  diary.ensureYesterdayDiary().then((r) => console.log('[diary]', r));
  reflection.ensureYesterdayReflection().then((r) => console.log('[reflection]', r));

  // 主动触发：启动问候 + 周期检查
  triggers.greet().then(petSpeak).catch((e) => console.error('[greet]', e && e.message));
  setInterval(() => {
    try {
      const idleSec = powerMonitor.getSystemIdleTime();
      perception.update(idleSec);           // 情绪感知：忙/空闲/离开
      if (idleSec < 90) habits.markActive(); // 习惯学习：记录用户活跃时段
      triggers.check(idleSec).then((result) => {
        if (!result) return;
        playTriggerAnimation(result.type);
        if (result.text) petSpeak(result.text);
      }).catch(() => {});
    } catch (e) {}
  }, 60 * 1000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createPetWindow();
      reconcilePet();
      startGazeTracking();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
