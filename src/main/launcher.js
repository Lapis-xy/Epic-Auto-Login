const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const EXE_SUBPATH = ['Epic Games', 'Launcher', 'Portal', 'Binaries', 'Win64', 'EpicGamesLauncher.exe'];

// Cerca l'exe in Program Files e Program Files (x86), senza duplicati
function launcherCandidates() {
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ].filter(Boolean);
  return [...new Set(roots)].map((r) => path.join(r, ...EXE_SUBPATH));
}

async function launchEpic() {
  if (process.platform === 'win32') {
    const candidates = launcherCandidates();
    const exe = candidates.find((p) => fs.existsSync(p));
    if (!exe) {
      throw new Error(`Launcher Epic non trovato. Percorsi controllati:\n${candidates.join('\n')}`);
    }
    spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
    return;
  }

  if (process.platform === 'darwin') {
    spawn('open', ['-a', 'Epic Games Launcher'], { detached: true, stdio: 'ignore' }).unref();
    return;
  }

  throw new Error('Epic Games Launcher non è disponibile su questo sistema');
}

// Apre Brave su una URL (per default Gmail). Solo Windows.
const BRAVE_SUBPATH = ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'];

function bravePaths() {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files', 'C:\\Program Files (x86)'];
  const list = [...new Set(roots.filter(Boolean))].map((r) => path.join(r, ...BRAVE_SUBPATH));
  if (process.env.LOCALAPPDATA) list.push(path.join(process.env.LOCALAPPDATA, ...BRAVE_SUBPATH));
  return list;
}

function ps(script) {
  // Prefisso DPI: coordinate dei monitor in pixel reali
  const full =
    "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class D { " +
    '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }\'; ' +
    '[D]::SetProcessDPIAware() | Out-Null; ' + script;
  const encoded = Buffer.from(full, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))
    );
  });
}

// Gmail risulta aperto se una finestra di Brave ha "Gmail" nel titolo (controlla la scheda attiva)
async function braveHasGmail() {
  const out = await ps(
    "Get-Process -Name brave -ErrorAction SilentlyContinue | " +
      "Where-Object { $_.MainWindowTitle -like '*Gmail*' } | Measure-Object | ForEach-Object { $_.Count }"
  );
  return Number(out) > 0;
}

// Angolo in alto a sinistra del primo monitor che non è quello principale
async function secondaryScreenOrigin() {
  const out = await ps(
    'Add-Type -AssemblyName System.Windows.Forms; ' +
      '$s = [System.Windows.Forms.Screen]::AllScreens | Where-Object { -not $_.Primary } | Select-Object -First 1; ' +
      'if ($s) { "$($s.Bounds.X),$($s.Bounds.Y)" } else { "NONE" }'
  );
  if (!out || out === 'NONE') return null;
  const [x, y] = out.split(',').map(Number);
  return { x, y };
}

// Ritorna 'already' se Gmail è già aperto, 'opened' se Brave è stato aperto
async function openBrave(url = 'https://mail.google.com/mail/u/0/') {
  if (process.platform !== 'win32') throw new Error('Apertura di Brave disponibile solo su Windows');
  const exe = bravePaths().find((p) => fs.existsSync(p));
  if (!exe) throw new Error('Brave non trovato');

  let already = false;
  try {
    already = await braveHasGmail();
  } catch {
    already = false;
  }
  if (already) return 'already';

  const args = ['--new-window'];
  let sec = null;
  try {
    sec = await secondaryScreenOrigin();
  } catch {
    sec = null;
  }
  if (sec) args.push(`--window-position=${sec.x + 60},${sec.y + 60}`, '--window-size=1100,700');
  args.push(url);

  spawn(exe, args, { detached: true, stdio: 'ignore' }).unref();
  return 'opened';
}

module.exports = { launchEpic, openBrave };