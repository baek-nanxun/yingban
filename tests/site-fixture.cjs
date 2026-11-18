const { app, BrowserWindow } = require('electron');
const { join } = require('node:path');
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1200, height: 900, show: true, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  window.loadFile(join(__dirname, '../site/index.html'));
});
app.on('window-all-closed', () => app.quit());
