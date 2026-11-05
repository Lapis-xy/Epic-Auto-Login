const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { safeStorage } = require('electron');

// Dati: MAGIC | IV(12) | TAG(16) | CIPHERTEXT (AES-256-GCM)
// Chiave: generata al primo avvio, salvata cifrata dal sistema (safeStorage)
const MAGIC = Buffer.from('EVLT2');
const IV_LEN = 12;
const TAG_LEN = 16;

class Vault {
  constructor(dir) {
    this.dir = dir;
    this.dataPath = path.join(dir, 'vault.enc');
    this.iconDir = path.join(dir, 'icons');
    this.keyPath = path.join(dir, 'vault.key');
    this.key = null;
    this.presets = [];
  }

  init() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.iconDir, { recursive: true });
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('La cifratura di sistema non è disponibile su questo account');
    }

    if (fs.existsSync(this.keyPath)) {
      const wrapped = fs.readFileSync(this.keyPath);
      this.key = Buffer.from(safeStorage.decryptString(wrapped), 'base64');
    } else {
      this.key = crypto.randomBytes(32);
      const wrapped = safeStorage.encryptString(this.key.toString('base64'));
      fs.writeFileSync(this.keyPath, wrapped, { mode: 0o600 });
    }

    this.presets = fs.existsSync(this.dataPath) ? this.readData() : [];
  }

  readData() {
    const raw = fs.readFileSync(this.dataPath);
    if (raw.length < MAGIC.length + IV_LEN + TAG_LEN || !raw.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error('File vault non valido');
    }
    let o = MAGIC.length;
    const iv = raw.subarray(o, (o += IV_LEN));
    const tag = raw.subarray(o, (o += TAG_LEN));
    const data = raw.subarray(o);
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(data), decipher.final()]);
      return JSON.parse(plain.toString('utf8'));
    } catch {
      throw new Error('Vault illeggibile: chiave non valida o file corrotto');
    }
  }

  save() {
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(JSON.stringify(this.presets), 'utf8'), cipher.final()]);
    const out = Buffer.concat([MAGIC, iv, cipher.getAuthTag(), enc]);

    const tmp = `${this.dataPath}.tmp`;
    fs.writeFileSync(tmp, out, { mode: 0o600 });
    fs.renameSync(tmp, this.dataPath);
  }

  // Senza password: usato dalla UI
  list() {
    return this.presets.map(({ id, name, email, icon, visible }) => ({
      id,
      name,
      email,
      icon: this.iconDataUrl(icon),
      visible: visible !== false,
    }));
  }

  // Immagine dell'icona come data URL, solo per la visualizzazione
  iconDataUrl(name) {
    if (!name) return null;
    const file = path.join(this.iconDir, name);
    if (!fs.existsSync(file)) return null;
    const ext = path.extname(name).toLowerCase();
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[ext];
    return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
  }

  // Copia l'immagine scelta nella cartella interna e ritorna il nome del file
  importIcon(srcPath) {
    const name = `${crypto.randomUUID()}${path.extname(srcPath).toLowerCase()}`;
    fs.copyFileSync(srcPath, path.join(this.iconDir, name));
    return name;
  }

  deleteIcon(name) {
    if (!name) return;
    try {
      fs.unlinkSync(path.join(this.iconDir, name));
    } catch {
      // file già assente: niente da fare
    }
  }

  // Con password: usato SOLO dal main process per il riempimento
  getWithSecret(id) {
    return this.presets.find((p) => p.id === id) || null;
  }

  validateIcon(icon) {
    if (icon === null) return null;
    if (typeof icon !== 'string' || !/^[a-f0-9-]{36}\.(png|jpe?g|gif|webp)$/i.test(icon)) {
      throw new Error('Icona non valida');
    }
    return icon;
  }

  add({ name, email, password, icon = null, visible = true }) {
    if (!name || !email || !password) throw new Error('Compila nome, email e password');
    const preset = {
      id: crypto.randomUUID(),
      name,
      email,
      password,
      icon: this.validateIcon(icon),
      visible: visible !== false,
    };
    this.presets.push(preset);
    this.save();
    return preset.id;
  }

  // Aggiorna solo i campi passati. password vuota = invariata. icon null = rimossa, undefined = invariata
  update(id, { name, email, password, icon, visible }) {
    const preset = this.presets.find((p) => p.id === id);
    if (!preset) throw new Error('Profilo non trovato');
    if (name) preset.name = name;
    if (email) preset.email = email;
    if (password) preset.password = password;
    if (icon !== undefined) {
      const old = preset.icon;
      preset.icon = this.validateIcon(icon);
      if (old && old !== preset.icon) this.deleteIcon(old);
    }
    if (visible !== undefined) preset.visible = !!visible;
    this.save();
  }

  remove(id) {
    const preset = this.presets.find((p) => p.id === id);
    if (preset) this.deleteIcon(preset.icon);
    this.presets = this.presets.filter((p) => p.id !== id);
    this.save();
  }
}

module.exports = { Vault };