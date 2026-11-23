const { contextBridge, ipcRenderer } = require('electron');
const subscribe = (name, listener) => {
  const handler = (_, payload) => listener(payload);
  ipcRenderer.on(name, handler);
  return () => ipcRenderer.removeListener(name, handler);
};
contextBridge.exposeInMainWorld('clearcall', {
  createRoom: () => ipcRenderer.invoke('room:create'),
  joinRoom: input => ipcRenderer.invoke('room:join', input),
  discoverRoom: input => ipcRenderer.invoke('room:discover', input),
  setWindowMode: mode => ipcRenderer.invoke('window:mode', mode),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  onWindowState: listener => subscribe('window:state', listener),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  openSettings: () => ipcRenderer.invoke('settings:open'),
  closeSettings: () => ipcRenderer.invoke('settings:close'),
  saveSettings: patch => ipcRenderer.invoke('settings:save', patch),
  reportDevices: list => ipcRenderer.invoke('settings:devices', list),
  reportStatus: status => ipcRenderer.invoke('settings:status', status),
  onSettings: listener => subscribe('settings:changed', listener),
  onRuntime: listener => subscribe('settings:runtime', listener),
  onSettingsVisible: listener => subscribe('settings:visible', listener),
  onProtocolInvite: listener => subscribe('protocol:invite', listener),
  setMiniState: state => ipcRenderer.invoke('mini:state', state),
  miniAction: action => ipcRenderer.invoke('mini:action', action),
  moveMini: point => ipcRenderer.invoke('mini:move', point),
  onMiniState: listener => subscribe('mini:state', listener),
  onMiniCommand: listener => subscribe('mini:command', listener),
  leaveRoom: () => ipcRenderer.invoke('room:leave'),
  send: message => ipcRenderer.invoke('signal:send', message),
  sources: () => ipcRenderer.invoke('sources:list'),
  selectSource: id => ipcRenderer.invoke('sources:select', id),
  audioApps: () => ipcRenderer.invoke('audio:apps'),
  startAudio: appKey => ipcRenderer.invoke('audio:start', appKey),
  stopAudio: () => ipcRenderer.invoke('audio:stop'),
  duckLocal: gain => ipcRenderer.invoke('audio:duck', gain),
  copy: input => ipcRenderer.invoke('clipboard:copy', input),
  checkUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: info => ipcRenderer.invoke('updates:download', info),
  openUpdate: url => ipcRenderer.invoke('updates:open', url),
  onUpdateProgress: listener => subscribe('updates:progress', listener),
  info: () => ipcRenderer.invoke('app:info'),
  onSignal: listener => subscribe('signal', listener),
  onPCM: listener => subscribe('audio:pcm', listener),
  onAudioEnded: listener => subscribe('audio:ended', listener),
  onDucked: listener => subscribe('audio:ducked', listener)
});
