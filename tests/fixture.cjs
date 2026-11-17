const { app, BrowserWindow, screen } = require('electron');
const { spawn } = require('node:child_process');
let tone;
app.whenReady().then(async () => {
  const display = screen.getAllDisplays().sort((a,b) => b.size.width*b.size.height*b.scaleFactor**2 - a.size.width*a.size.height*a.scaleFactor**2)[0];
  if (display.size.width * display.scaleFactor < 3840 || display.size.height * display.scaleFactor < 2160) throw new Error('A physical 4K display is required');
  const window = new BrowserWindow({ x: display.bounds.x, y: display.bounds.y, width: Math.round(3840 / display.scaleFactor), height: Math.round(2160 / display.scaleFactor), frame: false, fullscreen: true, title: 'YingBan Test Pattern', webPreferences: { sandbox: true, backgroundThrottling: false } });
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<title>YingBan Test Pattern</title><style>html,body{margin:0;height:100%;overflow:hidden}body{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr}div{display:grid;place-items:center;font:24px sans-serif;color:#142033}div:nth-child(1){background:#ff6b6b}div:nth-child(2){background:#65e0bd}div:nth-child(3){background:#80a7ff}div:nth-child(4){background:#f4d37a}</style><div>REAL WINDOW</div><div>APPLICATION AUDIO</div><div>YingBan</div><div>WINDOWS TEST</div>'));
  const tonePath = process.argv.find(arg => arg.startsWith('--tone='))?.slice(7);
  if (tonePath) {
    tone = spawn(tonePath, ['25'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    tone.on('error', () => {});
    setTimeout(() => { if (tone?.stdin.writable) tone.stdin.write('PLAY\n'); }, 500);
  }
});
app.on('window-all-closed', () => { tone?.kill(); app.quit(); });
