const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, dialog, globalShortcut, screen, clipboard } = require('electron');
const { Vault } = require('./vault');
const { launchEpic, openBrave } = require('./launcher');
const { fill, getCursorPos, placeEpic, EPIC_RECT } = require('./autofill');

const vault = new Vault(app.getPath('userData'));
let win = null;
let busy = false;
const CALIB_PATH = path.join(app.getPath('userData'), 'calibration.json');
// Le coordinate dei campi sono salvate relative a EPIC_RECT (in autofill.js).
const CALIB_VERSION = 3;

const ICON_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_ICON_FILE = 512 * 1024;

const { sleep, requestStop, reset, STOP_MSG } = require('./control');
const STOP_SHORTCUT = 'Control+Alt+X';
let overlay = null;
const sendStatus = (text) => win && win.webContents.send('status', text);

function createWindow() {
  win = new BrowserWindow({
    width: 800,
    height: 620,
    title: 'Epic Vault',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => {
    win = null;
  });
}

// Bordo rosso sopra tutto, trasparente al mouse: Epic resta cliccabile
function showOverlay() {
  if (overlay) return;
  const { bounds } = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    hasShadow: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
  overlay.on('closed', () => {
    overlay = null;
  });
}

function hideOverlay() {
  if (overlay) overlay.close();
  overlay = null;
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

handle('vault:list', () => vault.list());
handle('vault:add', (data) => vault.add(data));
handle('vault:update', (id, data) => vault.update(id, data));
handle('vault:remove', (id) => vault.remove(id));

// Apre il selettore file e ritorna l'immagine come data URL (oppure null se annullato)
handle('icon:pick', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Scegli un’icona',
    properties: ['openFile'],
    filters: [{ name: 'Immagini', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
  });
  if (res.canceled || !res.filePaths[0]) return null;

  const file = res.filePaths[0];
  const mime = ICON_MIME[path.extname(file).toLowerCase()];
  if (!mime) throw new Error('Formato immagine non supportato');
  if (fs.statSync(file).size > MAX_ICON_FILE) throw new Error('Immagine troppo grande (max 512 KB)');

  const name = vault.importIcon(file);
  return { file: name, dataUrl: vault.iconDataUrl(name) };
});

// Flusso: apri Epic -> attendi -> countdown -> email + Invio -> password (senza Invio finale)
handle('preset:fill', async (id) => {
  if (busy) throw new Error('Un’operazione è già in corso');
  const preset = vault.getWithSecret(id);
  if (!preset) throw new Error('Profilo non trovato');

  busy = true;
  reset();
  showOverlay();
  globalShortcut.register(STOP_SHORTCUT, () => {
    requestStop();
    sendStatus('Interruzione richiesta...');
  });
  try {
    if (process.platform === 'win32') {
      try {
        sendStatus('Apro Brave su Gmail...');
        const r = await openBrave();
        sendStatus(r === 'already' ? 'Gmail è già aperto in Brave.' : 'Brave aperto su Gmail.');
        await sleep(1500);
      } catch (err) {
        sendStatus(`Brave non aperto: ${err.message}. Continuo con Epic.`);
        await sleep(1500);
      }
    }

    sendStatus('Apro e posiziono il launcher Epic...');
    const points = await prepareEpic();

    for (let s = 5; s > 0; s--) {
      sendStatus(`Clicca nel campo EMAIL di Epic. Compilazione tra ${s}...`);
      await sleep(1000);
    }

    sendStatus('Compilazione in corso...');
    await fill({ email: preset.email, password: preset.password }, points, sendStatus);
    sendStatus('Compilato. Controlla i campi e premi Invio in Epic per accedere.');
  } catch (err) {
    if (err.message === STOP_MSG) {
      clipboard.clear();
      sendStatus('Operazione fermata. Il clipboard è stato svuotato.');
      return;
    }
    sendStatus(`Errore: ${err.message}`);
    throw err;
  } finally {
    globalShortcut.unregister(STOP_SHORTCUT);
    hideOverlay();
    busy = false;
  }
});

function readCalib() {
  try {
    const data = JSON.parse(fs.readFileSync(CALIB_PATH, 'utf8'));
    // Calibrazioni vecchie (coordinate assolute) vengono ignorate
    return data.v === CALIB_VERSION ? data : {};
  } catch {
    return {};
  }
}

// Apre Epic se serve, poi lo sposta nella posizione fissa
async function waitAndPlaceEpic() {
  if ((await placeEpic(EPIC_RECT)) === 'OK') return;
  await launchEpic();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await sleep(1000);
    if ((await placeEpic(EPIC_RECT)) === 'OK') {
      await sleep(1500); // attesa del rendering
      return;
    }
  }
  throw new Error('Il launcher Epic non si è aperto entro 30 secondi');
}

// Prepara Epic e restituisce le coordinate assolute dei campi
async function prepareEpic() {
  if (process.platform !== 'win32') {
    await launchEpic();
    await sleep(10000);
    return {};
  }
  await waitAndPlaceEpic();
  const calib = readCalib();
  const points = {};
  for (const f of ['email', 'password']) {
    if (calib[f]) points[f] = { x: calib[f].x, y: calib[f].y };
  }
  if (!points.password) {
    sendStatus('Attenzione: campo password non calibrato. Lo dovrai cliccare a mano.');
    await sleep(2000);
  }
  return points;
}

function writeCalib(data) {
  fs.writeFileSync(CALIB_PATH, JSON.stringify(data), { mode: 0o600 });
}

handle('calib:get', () => readCalib());

// Countdown, poi salva la posizione del mouse per il campo indicato
handle('calib:capture', async (field) => {
  if (process.platform !== 'win32') throw new Error('Calibrazione disponibile solo su Windows');
  if (!['email', 'password'].includes(field)) throw new Error('Campo non valido');
  const label = field === 'email' ? 'EMAIL' : 'PASSWORD';
  sendStatus('Apro e posiziono il launcher Epic...');
  await waitAndPlaceEpic();
  for (let s = 5; s > 0; s--) {
    sendStatus(`Posiziona il mouse sul campo ${label} di Epic... ${s}`);
    await sleep(1000);
  }
  const pos = await getCursorPos();
  const rel = { x: pos.x - EPIC_RECT.x, y: pos.y - EPIC_RECT.y };
  const calib = { ...readCalib(), v: CALIB_VERSION };
  calib[field] = rel;
  writeCalib(calib);
  sendStatus(`Campo ${field} salvato.`);
  return rel;
});

handle('calib:clear', () => {
  writeCalib({ v: CALIB_VERSION });
  sendStatus('Calibrazione azzerata.');
});

// Copia email o password negli appunti; si cancellano dopo 30 secondi
handle('secret:copy', (id, field) => {
  const preset = vault.getWithSecret(id);
  if (!preset) throw new Error('Profilo non trovato');
  const value = field === 'password' ? preset.password : preset.email;
  clipboard.writeText(value);
  setTimeout(() => {
    if (clipboard.readText() === value) clipboard.clear();
  }, 30000);
  return true;
});

// Pulsante FERMA nell'app
handle('preset:stop', () => {
  requestStop();
  sendStatus('Interruzione richiesta...');
});

app.whenReady().then(() => {
  try {
    vault.init();
  } catch (err) {
    dialog.showErrorBox('Epic Vault', err.message);
    app.quit();
    return;
  }
  createWindow();
});

app.on('window-all-closed', () => app.quit());

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && vault.key) createWindow();
});