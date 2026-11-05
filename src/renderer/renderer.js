const $ = (sel) => document.querySelector(sel);

let view = 'account';      // 'account' | 'manager'
let manageMode = false;
let addIcon = null;
let editingId = null;
let editIcon = undefined;  // undefined = invariata, null = rimossa, stringa = nuova

async function call(promise) {
  const res = await promise;
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

function setStatus(text) {
  $('#status').textContent = text;
}

function colorFor(text) {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360}, 45%, 38%)`;
}

function paintAvatar(el, { label, color, icon }) {
  el.textContent = '';
  el.style.background = color || 'transparent';
  if (icon) {
    const img = document.createElement('img');
    img.src = icon;
    img.alt = '';
    el.appendChild(img);
  } else {
    el.textContent = label || '';
  }
}

function makeTile({ label, name, email, color, icon, className = '', onClick }) {
  const tile = document.createElement('button');
  tile.className = `tile ${className}`.trim();
  tile.addEventListener('click', onClick);

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  paintAvatar(avatar, { label, color, icon });

  const nameEl = document.createElement('div');
  nameEl.className = 'tile-name';
  nameEl.textContent = name;

  const mailEl = document.createElement('div');
  mailEl.className = 'tile-mail';
  mailEl.textContent = email || '';

  tile.append(avatar, nameEl, mailEl);
  return tile;
}

// ---------- Caricamento e render ----------
let presets = [];

async function loadAll() {
  try {
    presets = await call(window.vault.list());
  } catch (err) {
    setStatus(err.message);
    presets = [];
  }
  renderGrid();
  renderList();
}

function renderGrid() {
  const grid = $('#grid');
  grid.innerHTML = '';
  const visible = presets.filter((p) => p.visible);

  for (const p of visible) {
    grid.appendChild(
      makeTile({
        label: p.name.charAt(0).toUpperCase(),
        name: p.name,
        email: p.email,
        color: colorFor(p.name),
        icon: p.icon,
        className: manageMode ? 'managing' : '',
        onClick: () => (manageMode ? openEdit(p) : fillPreset(p.id)),
      })
    );
  }

  grid.appendChild(makeTile({ label: '+', name: 'Aggiungi', className: 'add', onClick: openAdd }));

  if (presets.length === 0) setStatus('Nessun profilo. Apri Password manager per aggiungerne uno.');
  else if (visible.length === 0) setStatus('Nessun profilo visibile. Attiva "Mostra tra gli account" dal Password manager.');
}

function renderList() {
  const list = $('#list');
  list.innerHTML = '';
  if (presets.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nessuna voce salvata.';
    list.appendChild(li);
    return;
  }

  for (const p of presets) {
    const li = document.createElement('li');

    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('strong');
    name.textContent = p.name;
    const mail = document.createElement('span');
    mail.textContent = p.email;
    const vis = document.createElement('span');
    vis.className = p.visible ? 'badge on' : 'badge';
    vis.textContent = p.visible ? 'Visibile tra gli account' : 'Nascosto';
    info.append(name, mail, vis);

    const actions = document.createElement('div');
    actions.className = 'actions';

    const copyMail = document.createElement('button');
    copyMail.className = 'ghost';
    copyMail.textContent = 'Copia email';
    copyMail.addEventListener('click', () => copySecret(p.id, 'email', 'Email'));

    const copyPass = document.createElement('button');
    copyPass.className = 'ghost';
    copyPass.textContent = 'Copia password';
    copyPass.addEventListener('click', () => copySecret(p.id, 'password', 'Password'));

    const edit = document.createElement('button');
    edit.textContent = 'Modifica';
    edit.addEventListener('click', () => openEdit(p));

    actions.append(copyMail, copyPass, edit);
    li.append(info, actions);
    list.appendChild(li);
  }
}

// ---------- Cambio vista ----------
function setView(next) {
  view = next;
  manageMode = false;
  closeAdd();
  closeEdit();
  $('#account-view').hidden = view !== 'account';
  $('#manager-view').hidden = view !== 'manager';
  $('#manage-btn').hidden = view !== 'account';
  $('#manage-btn').textContent = 'Gestisci';
  $('#switch-btn').textContent = view === 'account' ? 'Password manager' : 'Account';
  $('#title').textContent = view === 'account' ? 'Chi sta giocando?' : 'Password manager';
  setStatus('');
  loadAll();
  if (view === 'manager') renderCalib();
}

$('#switch-btn').addEventListener('click', () => setView(view === 'account' ? 'manager' : 'account'));

$('#manage-btn').addEventListener('click', () => {
  manageMode = !manageMode;
  $('#manage-btn').textContent = manageMode ? 'Fine' : 'Gestisci';
  closeEdit();
  setStatus(manageMode ? 'Clicca un profilo per modificarlo o eliminarlo.' : '');
  renderGrid();
});

// ---------- Icone ----------
async function pickIconFor(target) {
  try {
    const res = await call(window.vault.pickIcon());
    if (!res) return;
    if (target === 'add') {
      addIcon = res.file;
      paintAvatar($('#add-preview'), { label: '+', color: 'var(--line)', icon: res.dataUrl });
    } else {
      editIcon = res.file;
      paintAvatar($('#edit-preview'), { label: '', color: 'var(--line)', icon: res.dataUrl });
    }
  } catch (err) {
    setStatus(`Errore: ${err.message}`);
  }
}

// ---------- Aggiungi ----------
function openAdd() {
  closeEdit();
  $('#add-form').reset();
  $('#p-visible').checked = true;
  addIcon = null;
  paintAvatar($('#add-preview'), { label: '+', color: 'var(--line)', icon: null });
  $('#add-box').hidden = false;
  $('#p-name').focus();
}

function closeAdd() {
  $('#add-form').reset();
  addIcon = null;
  $('#add-box').hidden = true;
}

$('#manager-add').addEventListener('click', openAdd);
$('#add-pick').addEventListener('click', () => pickIconFor('add'));
$('#add-cancel').addEventListener('click', closeAdd);

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = {
    name: $('#p-name').value.trim(),
    email: $('#p-email').value.trim(),
    password: $('#p-pass').value,
    icon: addIcon,
    visible: $('#p-visible').checked,
  };
  try {
    await call(window.vault.add(data));
    closeAdd();
    await loadAll();
    setStatus('Profilo salvato.');
  } catch (err) {
    setStatus(`Errore: ${err.message}`);
  }
});

// ---------- Modifica ----------
function openEdit(p) {
  closeAdd();
  editingId = p.id;
  editIcon = undefined;
  $('#e-name').value = p.name;
  $('#e-email').value = p.email;
  $('#e-pass').value = '';
  $('#e-visible').checked = p.visible;
  $('#edit-title').textContent = p.name;
  $('#edit-sub').textContent = p.email;
  paintAvatar($('#edit-preview'), { label: p.name.charAt(0).toUpperCase(), color: colorFor(p.name), icon: p.icon });
  $('#edit-box').hidden = false;
  $('#edit-box').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function closeEdit() {
  editingId = null;
  editIcon = undefined;
  $('#edit-form').reset();
  $('#edit-box').hidden = true;
}

$('#edit-pick').addEventListener('click', () => pickIconFor('edit'));
$('#edit-clear').addEventListener('click', () => {
  editIcon = null;
  const name = $('#e-name').value || '?';
  paintAvatar($('#edit-preview'), { label: name.charAt(0).toUpperCase(), color: colorFor(name), icon: null });
});
$('#edit-cancel').addEventListener('click', closeEdit);
$('#edit-delete').addEventListener('click', () => removePreset(editingId, $('#e-name').value));

$('#edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = {
    name: $('#e-name').value.trim(),
    email: $('#e-email').value.trim(),
    password: $('#e-pass').value,
    visible: $('#e-visible').checked,
  };
  if (editIcon !== undefined) data.icon = editIcon;
  try {
    await call(window.vault.update(editingId, data));
    closeEdit();
    await loadAll();
    setStatus('Profilo aggiornato.');
  } catch (err) {
    setStatus(`Errore: ${err.message}`);
  }
});

async function removePreset(id, name) {
  if (!confirm(`Eliminare il profilo "${name}"?`)) return;
  try {
    await call(window.vault.remove(id));
    closeEdit();
    await loadAll();
    setStatus('Profilo eliminato.');
  } catch (err) {
    setStatus(`Errore: ${err.message}`);
  }
}

// ---------- Riempimento ----------
async function fillPreset(id) {
  const unsubscribe = window.vault.onStatus(setStatus);
  $('#stop-btn').hidden = false;
  try {
    await call(window.vault.fill(id));
  } catch (err) {
    setStatus(`Errore: ${err.message}`);
  } finally {
    unsubscribe();
    $('#stop-btn').hidden = true;
  }
}

$('#stop-btn').addEventListener('click', () => window.vault.stop());

// ---------- Copia dagli appunti ----------
async function copySecret(id, field, label) {
  try {
    await call(window.vault.copy(id, field));
    setStatus(`${label} copiata. Si cancella dagli appunti tra 30 secondi.`);
  } catch (err) {
    setStatus(`Errore: ${err.message}`);
  }
}

// ---------- Calibrazione campi ----------
async function renderCalib() {
  try {
    const c = await call(window.vault.calibGet());
    const e = c.email ? 'impostato' : 'non impostato';
    const p = c.password ? 'impostato' : 'non impostato';
    $('#calib-info').textContent = `Campo email: ${e} · Campo password: ${p}`;
  } catch (err) {
    setStatus(`Errore: ${err.message}`);
  }
}

async function captureField(field) {
  try {
    await call(window.vault.calibCapture(field));
    await renderCalib();
  } catch (err) {
    setStatus(`Errore: ${err.message}`);
  }
}

$('#calib-email').addEventListener('click', () => captureField('email'));
$('#calib-pass').addEventListener('click', () => captureField('password'));
$('#calib-clear').addEventListener('click', async () => {
  try {
    await call(window.vault.calibClear());
    await renderCalib();
  } catch (err) {
    setStatus(`Errore: ${err.message}`);
  }
});

loadAll();