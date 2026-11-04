const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spider', {
  version: '0.1.0',
  dragStart: () => ipcRenderer.send('drag-start'),
  dragMove: () => ipcRenderer.send('drag-move'),
  dragEnd: () => ipcRenderer.send('drag-end'),
  hoverCat: (hovered) => ipcRenderer.send('pet-hit-test', hovered),
  openChat: () => ipcRenderer.send('open-chat'),
  chat: (msg, history) => ipcRenderer.invoke('agent-chat', { msg, history }),
  // 日记
  openDiary: () => ipcRenderer.send('open-diary'),
  listDiary: () => ipcRenderer.invoke('diary-list'),
  readDiary: (date) => ipcRenderer.invoke('diary-read', date),
  // 生理状态
  getVitals: () => ipcRenderer.invoke('vitals-get'),
  feed: () => ipcRenderer.invoke('vitals-feed'),
  pet: () => ipcRenderer.invoke('vitals-pet'),
  play: () => ipcRenderer.invoke('vitals-play'),
  wake: () => ipcRenderer.invoke('vitals-wake'),
  // 行为动画信号
  onAnim: (cb) => ipcRenderer.on('pet-anim', (e, type) => cb(type)),
  onGaze: (cb) => ipcRenderer.on('pet-gaze', (e, direction) => cb(direction)),
  // 说话气泡
  onSpeak: (cb) => ipcRenderer.on('pet-speak', (e, text) => cb(text)),
  // 调试：演示主动触发
  debugFire: (type) => ipcRenderer.invoke('debug-fire', type),
});
