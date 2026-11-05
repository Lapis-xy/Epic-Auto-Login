// Stato di interruzione dell'operazione in corso (Ctrl+Alt+X)
const STOP_MSG = 'Operazione interrotta';
let cancelled = false;

function requestStop() {
  cancelled = true;
}

function reset() {
  cancelled = false;
}

function check() {
  if (cancelled) throw new Error(STOP_MSG);
}

// sleep che si interrompe appena viene richiesto lo stop
async function sleep(ms) {
  const end = Date.now() + ms;
  for (;;) {
    check();
    const left = end - Date.now();
    if (left <= 0) return;
    await new Promise((r) => setTimeout(r, Math.min(100, left)));
  }
}

module.exports = { STOP_MSG, requestStop, reset, check, sleep };