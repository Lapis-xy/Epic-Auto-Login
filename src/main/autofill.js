const { spawn, execFile } = require('node:child_process');
const { clipboard } = require('electron');

const { sleep, check } = require('./control');

// Posizione fissa della finestra di Epic (pixel dello schermo). Le coordinate dei campi sono relative a questo punto.
const EPIC_RECT = { x: 100, y: 100, w: 1100, h: 700 };

// PowerShell dichiara di essere consapevole della scala di Windows, così le coordinate
// dei click coincidono con quelle della finestra e del cursore.
const DPI_PREFIX = "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class D { [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); }'; [D]::SetProcessDPIAware() | Out-Null; ";

// Esegue un comando senza shell (macOS)
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'ignore' });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))));
  });
}

// Esegue uno script PowerShell codificato in base64: niente problemi di quoting
function psRun(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))
    );
  });
}

async function sendKey(winKeys, macStatements) {
  if (process.platform === 'win32') {
    return psRun(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${winKeys}')`);
  }
  if (process.platform === 'darwin') {
    const args = [];
    for (const s of macStatements) args.push('-e', `tell application "System Events" to ${s}`);
    return run('osascript', args);
  }
  throw new Error('Piattaforma non supportata');
}

const paste = () => sendKey('^v', ['keystroke "v" using command down']);
const enter = () => sendKey('{ENTER}', ['key code 36']);
// Seleziona tutto e cancella: ripulisce il campo prima di scrivere
const clearField = () => sendKey('^a{DEL}', ['keystroke "a" using command down', 'key code 51']);

// ---------- Mouse (solo Windows) ----------
const CURSOR_CS =
  'using System; using System.Runtime.InteropServices; public class C { ' +
  '[DllImport("user32.dll")] public static extern bool GetCursorPos(out int x, out int y); }';

const CLICK_CS =
  'using System; using System.Runtime.InteropServices; public class M { ' +
  '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); ' +
  '[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e); }';

// Posizione del mouse in pixel dello schermo, con controllo di validità
async function getCursorPos() {
  if (process.platform !== 'win32') throw new Error('Calibrazione disponibile solo su Windows');
  const out = await psRun(
    `${DPI_PREFIX}Add-Type -AssemblyName System.Windows.Forms; ` +
      `$c = [System.Windows.Forms.Cursor]::Position; "$($c.X),$($c.Y)"`
  );
  const [x, y] = out.split(',').map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(y) || y <= 0 || x <= 0) {
    throw new Error(`Posizione del mouse non valida (${x}, ${y}). Riprova a calibrare.`);
  }
  return { x, y };
}

async function clickAt(x, y) {
  if (process.platform !== 'win32') return; // non disponibile su macOS
  const X = Math.round(x);
  const Y = Math.round(y);
  await psRun(
    `${DPI_PREFIX}Add-Type -TypeDefinition '${CLICK_CS}'; [M]::SetCursorPos(${X}, ${Y}); Start-Sleep -Milliseconds 150; ` +
      `[M]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [M]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)`
  );
}

// ---------- Riempimento ----------
// points: { email: {x,y}, password: {x,y} } opzionali, dalla calibrazione
// Flusso: [click email] -> pulizia -> email -> Invio -> attesa -> [click password] -> pulizia -> password
// Dopo la password preme Invio per accedere.
// points sono relativi alla finestra di Epic: la posizione assoluta si ricalcola a ogni click
async function fill({ email, password }, points = {}, log = () => {}) {
  const clickField = async (rel) => {
    check();
    if ((await placeEpic(EPIC_RECT)) !== 'OK') throw new Error('Finestra di Epic non trovata');
    await sleep(300);
    const x = EPIC_RECT.x + rel.x;
    const y = EPIC_RECT.y + rel.y;
    log(`Clic su (${x}, ${y})`);
    await clickAt(x, y);
    await sleep(300);
  };

  if (points.email) await clickField(points.email);
  await clearField();
  await sleep(150);
  clipboard.writeText(email);
  await sleep(150);
  await paste();
  await sleep(300);

  await enter();
  await sleep(3500); // attesa della schermata password

  if (points.password) await clickField(points.password);
  await clearField();
  await sleep(150);
  clipboard.writeText(password);
  await sleep(150);
  await paste();
  await sleep(300);
  await enter();
  await sleep(300);

  clipboard.clear();
}

// ---------- Finestra di Epic (solo Windows) ----------
const EPIC_CS =
  'using System; using System.Runtime.InteropServices; public class W { ' +
  '[DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool r); ' +
  '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); ' +
  '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); ' +
  '[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, ref RECT r); ' +
  '[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); ' +
  '[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; } }';

// Sceglie la finestra VISIBILE più grande del processo di Epic (ne ha più di una)
const EPIC_HANDLE =
  '$p = $null; $bestArea = 0; ' +
  'foreach ($q in (Get-Process -Name EpicGamesLauncher -ErrorAction SilentlyContinue)) { ' +
  '  $h = $q.MainWindowHandle; ' +
  '  if ($h -ne 0 -and [W]::IsWindowVisible($h)) { ' +
  '    $r = New-Object W+RECT; [W]::GetWindowRect($h, [ref]$r) | Out-Null; ' +
  '    $a = ($r.Right - $r.Left) * ($r.Bottom - $r.Top); ' +
  '    if ($a -gt $bestArea) { $bestArea = $a; $p = $h } ' +
  '  } ' +
  '}';

// Sposta e ridimensiona la finestra di Epic. Ritorna 'OK' oppure 'NONE' se non è aperta.
async function placeEpic({ x, y, w, h }) {
  if (process.platform !== 'win32') return 'NONE';
  return psRun(
    `${DPI_PREFIX}Add-Type -TypeDefinition '${EPIC_CS}'; ${EPIC_HANDLE}; ` +
      `if (-not $p) { 'NONE' } else { [W]::ShowWindow($p, 9) | Out-Null; ` +
      `[W]::MoveWindow($p, ${x}, ${y}, ${w}, ${h}, $true) | Out-Null; ` +
      `[W]::SetForegroundWindow($p) | Out-Null; 'OK' }`
  );
}

// Angolo in alto a sinistra della finestra di Epic, in pixel dello schermo
async function getEpicOrigin() {
  const out = await psRun(
    `${DPI_PREFIX}Add-Type -TypeDefinition '${EPIC_CS}'; ${EPIC_HANDLE}; ` +
      `if (-not $p) { 'NONE' } else { $r = New-Object W+RECT; ` +
      `[W]::GetWindowRect($p, [ref]$r) | Out-Null; "$($r.Left),$($r.Top)" }`
  );
  if (!out || out === 'NONE') throw new Error('Finestra di Epic non trovata');
  const [x, y] = out.split(',').map(Number);
  return { x, y };
}

module.exports = { fill, getCursorPos, placeEpic, EPIC_RECT };