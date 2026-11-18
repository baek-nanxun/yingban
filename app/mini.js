(() => {
  const api = window.clearcall, button = document.getElementById('mic'), icon = document.getElementById('micIcon');
  let active = false, origin, dragged = false;
  api.onMiniState(state => { active = Boolean(state?.mic); icon.setAttribute('href', `icons.svg#${active ? 'mic' : 'mic-off'}`); button.title = button.ariaLabel = active ? '关闭麦克风' : '开启麦克风'; });
  button.addEventListener('pointerdown', event => { if (event.button !== 0) return; origin = { x: event.screenX, y: event.screenY, windowX: window.screenX, windowY: window.screenY }; dragged = false; button.setPointerCapture(event.pointerId); });
  button.addEventListener('pointermove', event => { if (!origin) return; const dx = event.screenX - origin.x, dy = event.screenY - origin.y; if (Math.abs(dx) + Math.abs(dy) > 4) dragged = true; if (dragged) void api.moveMini({ x: origin.windowX + dx, y: origin.windowY + dy }); });
  button.addEventListener('pointerup', () => { origin = undefined; });
  button.addEventListener('pointercancel', () => { origin = undefined; });
  button.addEventListener('click', () => { if (dragged) { dragged = false; return; } void api.miniAction('toggle-mic'); });
})();
