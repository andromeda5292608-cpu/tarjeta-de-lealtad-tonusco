'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = __dirname;
loadEnv(path.join(ROOT, '.env'));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DATA_FILE = path.resolve(process.env.DATA_FILE || path.join(ROOT, 'data', 'tonusco.json'));
const SESSION_TTL = 12 * 60 * 60 * 1000;
const STAMP_COOLDOWN_MS = 48 * 60 * 60 * 1000;
const STAMP_LIMIT = 9;
const sessions = new Map();
const loginAttempts = new Map();
const publicAttempts = new Map();
const PASSWORD_SALT = crypto.randomBytes(16);
const PASSWORD_HASH = ADMIN_PASSWORD ? crypto.scryptSync(ADMIN_PASSWORD, PASSWORD_SALT, 64) : null;

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}

function readDb() {
  try {
    const value = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (value && Array.isArray(value.guests)) return value;
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('No se pudo leer la base de datos:', error.message);
  }
  return { version: 1, guests: [] };
}

let db = readDb();
let needsMigration = false;
for (const guest of db.guests) {
  if (!guest.cardNo) { guest.cardNo = createCardNo(db.guests); needsMigration = true; }
  if (!Array.isArray(guest.history)) { guest.history = []; needsMigration = true; }
  // Keep the earned discount for cards created under the previous one-stamp-per-tier rules.
  if (!Number.isInteger(guest.stampProgress)) {
    guest.stampProgress = Math.min(Math.max(Number(guest.visits) || 0, 0) * 2, STAMP_LIMIT);
    needsMigration = true;
  }
  if (guest.stampProgress > STAMP_LIMIT) { guest.stampProgress = STAMP_LIMIT; needsMigration = true; }
  for (const event of guest.history) {
    if (event.type === 'stamp' && event.discountGranted == null) {
      event.discountGranted = Number(event.nextReward ?? Math.min((Number(event.visitNumber) || 0) * 5, 25));
      needsMigration = true;
    }
  }
}
if (needsMigration) writeDb();
function writeDb() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const temp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(temp, DATA_FILE);
}

function send(res, status, payload, headers = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': typeof payload === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https://api.qrserver.com; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    ...headers,
  });
  res.end(body);
}

function normalizePhone(raw) {
  let phone = String(raw || '').replace(/\D/g, '');
  if (phone.startsWith('57') && phone.length === 12) phone = phone.slice(2);
  return phone;
}
function reward(stamps) { return Math.min(Math.ceil(Math.max(Number(stamps) || 0, 0) / 2) * 5, 25); }
function createCardNo(guests = db.guests) {
  const used = new Set(guests.map((guest) => String(guest.cardNo || '')));
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const value = String(crypto.randomInt(100, 1000));
    if (!used.has(value)) return value;
  }
  return String(crypto.randomInt(100000, 1000000));
}
function mostRecentStamp(guest) {
  const history = guest.history || [];
  const stampEvents = history.filter((event) => event.type === 'stamp' && !event.voidedAt && !event.deletedAt);
  const legacyFallback = !stampEvents.length && !history.some((event) => event.type === 'stamp') ? [guest.lastStampAt] : [];
  const dates = [...legacyFallback, ...stampEvents.map((event) => event.date)]
    .filter(Boolean).map((value) => Date.parse(value)).filter(Number.isFinite);
  return dates.length ? Math.max(...dates) : 0;
}
function recordStamps(guest, { source, count = 1, jacuzziDelivered = false, bypassCooldown = false }) {
  const numberOfStamps = Number(count);
  if (!Number.isInteger(numberOfStamps) || numberOfStamps < 1) return { error: 'Selecciona una cantidad válida de sellos.' };
  const progress = Math.min(Math.max(Number(guest.stampProgress) || 0, 0), STAMP_LIMIT);
  if (progress >= STAMP_LIMIT) return { error: 'Esta tarjeta ya completó sus 9 sellos.' };
  if (numberOfStamps > STAMP_LIMIT - progress) return { error: `Solo quedan ${STAMP_LIMIT - progress} sellos disponibles en esta tarjeta.` };
  const now = Date.now();
  const last = mostRecentStamp(guest);
  if (!bypassCooldown && last && now - last < STAMP_COOLDOWN_MS) {
    const next = last + STAMP_COOLDOWN_MS;
    const date = new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Bogota' }).format(new Date(next));
    return { error: `Este sello ya fue registrado recientemente. Podrá registrarse otro el ${date}.`, nextAllowedAt: new Date(next).toISOString() };
  }
  const previousReward = reward(progress);
  const events = [];
  for (let index = 0; index < numberOfStamps; index += 1) {
    const stampNumber = progress + index + 1;
    const granted = reward(stampNumber);
    const jacuzziEarned = granted === 25 && reward(stampNumber - 1) < 25;
    const date = new Date(now).toISOString();
    events.push({
      id: crypto.randomUUID(), type: 'stamp', source, date,
      visitNumber: (Number(guest.visits) || 0) + index + 1,
      stampNumber,
      discountAtArrival: previousReward,
      discountGranted: granted,
      jacuzziEarned,
      jacuzziDelivered: jacuzziEarned && Boolean(jacuzziDelivered),
      nextReward: granted,
    });
  }
  guest.visits = (Number(guest.visits) || 0) + numberOfStamps;
  guest.stampProgress = progress + numberOfStamps;
  guest.history = [...(guest.history || []), ...events];
  guest.lastStampAt = events[events.length - 1].date;
  guest.updatedAt = guest.lastStampAt;
  writeDb();
  return { events };
}
function publicGuest(guest) {
  const history = (guest.history || []).filter((event) => event.type === 'stamp' && !event.voidedAt && !event.deletedAt).map((event) => ({
    date: event.date,
    visitNumber: event.visitNumber || null,
    stampNumber: event.stampNumber || null,
    source: event.source || null,
    discountGranted: Number(event.discountGranted ?? event.nextReward ?? 0),
  })).reverse();
  return { name: guest.name, cardNo: guest.cardNo, visits: guest.visits, stampProgress: guest.stampProgress, reward: reward(guest.stampProgress), history };
}
function issueCardAccess(guest) {
  const token = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const tokens = Array.isArray(guest.cardAccessTokens) ? guest.cardAccessTokens : [];
  guest.cardAccessTokens = [...tokens.filter((item) => item && /^[a-f0-9]{64}$/.test(item.hash || '')), { hash, createdAt: new Date().toISOString() }].slice(-5);
  return token;
}
function cardAccessCookie(token, req) {
  const secure = process.env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `tonusco_card=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure}`;
}
function cardAccessGuest(req) {
  const match = String(req.headers.cookie || '').match(/(?:^|;\s*)tonusco_card=([a-f0-9]{64})(?:;|$)/);
  if (!match) return null;
  const candidate = crypto.createHash('sha256').update(match[1]).digest();
  return db.guests.find((guest) => (guest.cardAccessTokens || []).some((item) => {
    try {
      const stored = Buffer.from(item.hash, 'hex');
      return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
    } catch { return false; }
  })) || null;
}
function walletGoogleEnabled() {
  if (!/^\d+$/.test(String(process.env.GOOGLE_WALLET_ISSUER_ID || '').trim()) || !String(process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL || '').includes('@')) return false;
  try {
    const privateKey = String(process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    crypto.createPrivateKey(privateKey);
    return true;
  } catch { return false; }
}
function walletAppleEnabled() {
  return Boolean(process.env.APPLE_PASS_CERT_P12_BASE64 && process.env.APPLE_PASS_CERT_PASSWORD && process.env.APPLE_PASS_TYPE_IDENTIFIER && process.env.APPLE_TEAM_IDENTIFIER && process.env.APPLE_WWDR_CERT_BASE64);
}
function requestOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] ? String(req.headers['x-forwarded-proto']).split(',')[0].trim() : (req.socket.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] ? String(req.headers['x-forwarded-host']).split(',')[0].trim() : req.headers.host;
  return `${proto}://${host}`;
}
function base64url(value) { return Buffer.from(value).toString('base64url'); }
function googleWalletUrl(guest, origin) {
  const issuerId = String(process.env.GOOGLE_WALLET_ISSUER_ID || '').trim();
  if (!/^\d+$/.test(issuerId)) throw new Error('El emisor de Google Wallet no está configurado correctamente.');
  const classId = `${issuerId}.tonuscoLoyalty`;
  const objectId = `${issuerId}.member_${guest.id.replace(/-/g, '')}`;
  const progress = Math.min(Number(guest.stampProgress) || 0, STAMP_LIMIT);
  const passClass = {
    id: classId,
    issuerName: 'Hostería Tonusco',
    programName: 'Tarjeta VIP Tonusco',
    reviewStatus: 'underReview',
    hexBackgroundColor: '#173B2D',
    accountNameLabel: 'Titular',
    accountIdLabel: 'Tarjeta',
    programLogo: {
      sourceUri: { uri: `${origin}/icon-tonusco-192.png` },
      contentDescription: { defaultValue: { language: 'es-CO', value: 'Hostería Tonusco Campestre' } },
    },
  };
  const passObject = {
    id: objectId,
    classId,
    state: 'active',
    accountName: guest.name,
    accountId: String(guest.cardNo),
    barcode: { type: 'QR_CODE', value: String(guest.cardNo), alternateText: `Tarjeta VIP ${guest.cardNo}` },
    loyaltyPoints: { label: 'Sellos', balance: { string: `${progress}/9` } },
    secondaryLoyaltyPoints: { label: 'Descuento', balance: { string: `${reward(progress)}%` } },
  };
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: String(process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL).trim(),
    aud: 'google',
    typ: 'savetowallet',
    origins: [origin],
    payload: { loyaltyClasses: [passClass], loyaltyObjects: [passObject] },
  }));
  const privateKey = String(process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_PRIVATE_KEY).replace(/\\n/g, '\n');
  const unsigned = `${header}.${claims}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
  const jwt = `${unsigned}.${signature}`;
  if (jwt.length > 1800) throw new Error('La tarjeta de Wallet supera el tamaño permitido para el enlace.');
  return `https://pay.google.com/gp/v/save/${jwt}`;
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function makeZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((Math.max(now.getFullYear(), 1980) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const [fileName, rawContent] of Object.entries(files)) {
    const name = Buffer.from(fileName, 'utf8');
    const content = Buffer.isBuffer(rawContent) ? rawContent : Buffer.from(rawContent);
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8); local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    localParts.push(local, name, content);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt16LE(0, 10); central.writeUInt16LE(dosTime, 12); central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + content.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}
function appleCertificatePem(temporaryDirectory) {
  const encoded = String(process.env.APPLE_WWDR_CERT_BASE64).trim();
  const raw = encoded.includes('-----BEGIN CERTIFICATE-----') ? Buffer.from(encoded) : Buffer.from(encoded, 'base64');
  const certPath = path.join(temporaryDirectory, 'wwdr-input');
  const pemPath = path.join(temporaryDirectory, 'wwdr.pem');
  fs.writeFileSync(certPath, raw, { mode: 0o600 });
  if (raw.toString('utf8').includes('-----BEGIN CERTIFICATE-----')) fs.copyFileSync(certPath, pemPath);
  else execFileSync('openssl', ['x509', '-inform', 'DER', '-in', certPath, '-out', pemPath]);
  return pemPath;
}
function appleWalletPass(guest) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tonusco-wallet-'));
  try {
    const p12Path = path.join(temporaryDirectory, 'signer.p12');
    const certPath = path.join(temporaryDirectory, 'signer-cert.pem');
    const keyPath = path.join(temporaryDirectory, 'signer-key.pem');
    const manifestPath = path.join(temporaryDirectory, 'manifest.json');
    const signaturePath = path.join(temporaryDirectory, 'signature');
    const passPassword = String(process.env.APPLE_PASS_CERT_PASSWORD);
    const commandEnv = { ...process.env, TONUSCO_APPLE_CERT_PASSWORD: passPassword };
    fs.writeFileSync(p12Path, Buffer.from(String(process.env.APPLE_PASS_CERT_P12_BASE64).trim(), 'base64'), { mode: 0o600 });
    execFileSync('openssl', ['pkcs12', '-in', p12Path, '-clcerts', '-nokeys', '-out', certPath, '-passin', 'env:TONUSCO_APPLE_CERT_PASSWORD'], { env: commandEnv, stdio: 'ignore' });
    execFileSync('openssl', ['pkcs12', '-in', p12Path, '-nocerts', '-nodes', '-out', keyPath, '-passin', 'env:TONUSCO_APPLE_CERT_PASSWORD'], { env: commandEnv, stdio: 'ignore' });
    const progress = Math.min(Number(guest.stampProgress) || 0, STAMP_LIMIT);
    const pass = {
      formatVersion: 1,
      passTypeIdentifier: String(process.env.APPLE_PASS_TYPE_IDENTIFIER).trim(),
      serialNumber: `tonusco-${guest.id}`,
      teamIdentifier: String(process.env.APPLE_TEAM_IDENTIFIER).trim(),
      organizationName: 'Hostería Tonusco Campestre',
      description: 'Tarjeta VIP de lealtad Tonusco Campestre',
      logoText: 'Tonusco Campestre',
      foregroundColor: 'rgb(255, 255, 255)',
      backgroundColor: 'rgb(23, 59, 45)',
      labelColor: 'rgb(241, 181, 28)',
      storeCard: {
        primaryFields: [{ key: 'member', label: 'TITULAR', value: guest.name }],
        secondaryFields: [
          { key: 'reward', label: 'DESCUENTO', value: `${reward(progress)}%` },
          { key: 'stamps', label: 'SELLOS', value: `${progress}/9` },
        ],
        backFields: [
          { key: 'benefit', label: 'BENEFICIO', value: 'Al alcanzar el 25%, el titular y sus acompañantes reciben una hora de jacuzzi.' },
          { key: 'terms', label: 'CONDICIONES', value: 'Tarjeta permanente y no transferible. Aplica a consumos de hospedaje o días de sol. No acumulable con otras promociones.' },
          { key: 'web', label: 'HOSTERÍA TONUSCO CAMPESTRE', value: 'https://www.tonuscocampestre.com' },
        ],
      },
      barcode: { format: 'PKBarcodeFormatQR', message: String(guest.cardNo), messageEncoding: 'iso-8859-1', altText: `Tarjeta VIP ${guest.cardNo}` },
      barcodes: [{ format: 'PKBarcodeFormatQR', message: String(guest.cardNo), messageEncoding: 'iso-8859-1', altText: `Tarjeta VIP ${guest.cardNo}` }],
    };
    const files = {
      'pass.json': Buffer.from(JSON.stringify(pass)),
      'icon.png': fs.readFileSync(path.join(ROOT, 'icon-tonusco-192.png')),
      'logo.png': fs.readFileSync(path.join(ROOT, 'icon-tonusco-192.png')),
    };
    const manifest = Object.fromEntries(Object.entries(files).map(([name, content]) => [name, crypto.createHash('sha1').update(content).digest('hex')]));
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const wwdrPath = appleCertificatePem(temporaryDirectory);
    execFileSync('openssl', ['smime', '-sign', '-binary', '-in', manifestPath, '-signer', certPath, '-inkey', keyPath, '-certfile', wwdrPath, '-out', signaturePath, '-outform', 'DER'], { stdio: 'ignore' });
    files['manifest.json'] = fs.readFileSync(manifestPath);
    files.signature = fs.readFileSync(signaturePath);
    return makeZip(files);
  } catch (error) {
    console.error('No se pudo preparar el pase de Apple Wallet:', error.message);
    throw new Error('No pudimos preparar la tarjeta para Apple Wallet. Revisa el certificado y la configuración de Wallet.');
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
function escapeCsv(value) { return `"${String(value ?? '').replace(/"/g, '""')}"`; }
function localDateKey(value) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) throw new Error('La solicitud es demasiado grande.');
  }
  return raw ? JSON.parse(raw) : {};
}

function sessionFrom(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)tonusco_session=([a-f0-9]+)/);
  const token = match?.[1];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL;
  return token;
}

function allowPublicRequest(req, scope, limit, windowMs = 60 * 60 * 1000) {
  const forwardedFor = req.headers['x-forwarded-for'];
  const ip = forwardedFor ? String(forwardedFor).split(',')[0].trim() : (req.socket.remoteAddress || 'unknown');
  const key = `${scope}:${ip}`;
  const now = Date.now();
  const entry = publicAttempts.get(key) || { count: 0, startedAt: now };
  if (now - entry.startedAt >= windowMs) { entry.count = 0; entry.startedAt = now; }
  if (entry.count >= limit) return false;
  entry.count += 1;
  publicAttempts.set(key, entry);
  return true;
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const forwardedProto = req.headers['x-forwarded-proto'];
  const forwardedHost = req.headers['x-forwarded-host'];
  const protocol = forwardedProto ? String(forwardedProto).split(',')[0].trim() : (req.socket.encrypted ? 'https' : 'http');
  const host = forwardedHost ? String(forwardedHost).split(',')[0].trim() : req.headers.host;
  return origin === `${protocol}://${host}`;
}

function requireAdmin(req, res) {
  if (!sessionFrom(req)) {
    send(res, 401, { error: 'Inicia sesión para continuar.' });
    return false;
  }
  return true;
}

function safeGuest(guest) {
  const activeStamps = (guest.history || []).filter((item) => item.type === 'stamp' && !item.voidedAt && !item.deletedAt);
  return {
    id: guest.id,
    cardNo: guest.cardNo,
    name: guest.name,
    phone: guest.phone,
    visits: guest.visits,
    stampProgress: guest.stampProgress,
    reward: reward(guest.stampProgress),
    createdAt: guest.createdAt,
    lastStampAt: guest.lastStampAt || null,
    jacuzziPending: activeStamps.some((item) => item.jacuzziEarned === true || (Number(item.nextReward ?? item.discountGranted) === 25 && Number(item.stampNumber) === STAMP_LIMIT))
      && !(guest.history || []).some((item) => item.jacuzziDelivered === true && !item.deletedAt),
    history: (guest.history || []).filter((item) => !item.deletedAt).slice().reverse(),
  };
}

async function api(req, res, url) {
  const method = req.method;
  const pathname = url.pathname;
  if (method === 'GET' && pathname === '/api/health') return send(res, 200, { ok: true });
  if (method === 'GET' && pathname === '/api/wallet/status') {
    return send(res, 200, { google: walletGoogleEnabled(), apple: walletAppleEnabled() });
  }
  if (method === 'GET' && (pathname === '/wallet/google' || pathname === '/wallet/apple')) {
    const provider = pathname.endsWith('/google') ? 'google' : 'apple';
    if (!allowPublicRequest(req, `wallet-${provider}`, 20)) return send(res, 429, 'Inténtalo de nuevo más tarde.');
    const guest = cardAccessGuest(req);
    if (!guest) return send(res, 401, 'Vuelve a consultar tu tarjeta con el número de celular para continuar.');
    try {
      if (provider === 'google') {
        if (!walletGoogleEnabled()) return send(res, 503, 'Google Wallet aún no está configurado para Tonusco.');
        const target = googleWalletUrl(guest, requestOrigin(req));
        res.writeHead(303, { Location: target, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        return res.end();
      }
      if (!walletAppleEnabled()) return send(res, 503, 'Apple Wallet aún no está configurado para Tonusco.');
      const pass = appleWalletPass(guest);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.pkpass',
        'Content-Disposition': `attachment; filename="tonusco-${String(guest.cardNo).replace(/[^a-zA-Z0-9_-]/g, '')}.pkpass"`,
        'Content-Length': pass.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      return res.end(pass);
    } catch (error) {
      console.error(`No se pudo generar la tarjeta de ${provider} Wallet:`, error.message);
      return send(res, 503, { error: error.message || 'No pudimos preparar la tarjeta para Wallet.' });
    }
  }

  if (method === 'POST' && pathname === '/api/card') {
    if (!originAllowed(req)) return send(res, 403, { error: 'Solicitud no permitida.' });
    if (!allowPublicRequest(req, 'card', 120)) return send(res, 429, { error: 'Has hecho muchas consultas. Inténtalo más tarde.' });
    try {
      const { phone: rawPhone } = await readJson(req);
      const phone = normalizePhone(rawPhone);
      if (phone.length < 7 || phone.length > 15) return send(res, 400, { error: 'Escribe un número de celular válido.' });
      const guest = db.guests.find((item) => item.phone === phone);
      if (!guest) return send(res, 404, { error: 'No encontramos una tarjeta con ese número.' });
      const token = issueCardAccess(guest);
      writeDb();
      return send(res, 200, { card: publicGuest(guest) }, { 'Set-Cookie': cardAccessCookie(token, req) });
    } catch {
      return send(res, 400, { error: 'No pudimos consultar la tarjeta. Intenta de nuevo.' });
    }
  }

  if (method === 'POST' && pathname === '/api/card/access') {
    if (!originAllowed(req)) return send(res, 403, { error: 'Solicitud no permitida.' });
    if (!allowPublicRequest(req, 'card-access', 120)) return send(res, 429, { error: 'Inténtalo de nuevo más tarde.' });
    const guest = cardAccessGuest(req);
    if (!guest) return send(res, 401, { error: 'No encontramos el acceso guardado de esta tarjeta. Vuelve a inscribirte con el QR de registro.' });
    return send(res, 200, { card: publicGuest(guest) });
  }

  if (method === 'POST' && pathname === '/api/enroll') {
    if (!originAllowed(req)) return send(res, 403, { error: 'Solicitud no permitida.' });
    if (!allowPublicRequest(req, 'enroll', 50)) return send(res, 429, { error: 'Se alcanzó el límite de registros desde esta red. Inténtalo más tarde.' });
    try {
      const { name: rawName, phone: rawPhone, consent } = await readJson(req);
      const name = String(rawName || '').trim().replace(/\s+/g, ' ');
      const phone = normalizePhone(rawPhone);
      if (name.length < 2 || name.length > 100) return send(res, 400, { error: 'Escribe un nombre válido.' });
      if (phone.length < 7 || phone.length > 15) return send(res, 400, { error: 'Escribe un número de celular válido.' });
      if (consent !== true) return send(res, 400, { error: 'Debes aceptar el uso de tus datos para crear la tarjeta.' });
      const existing = db.guests.find((item) => item.phone === phone);
      if (existing) {
        const token = issueCardAccess(existing);
        writeDb();
        return send(res, 200, { card: publicGuest(existing), alreadyRegistered: true }, { 'Set-Cookie': cardAccessCookie(token, req) });
      }
      const guest = {
        id: crypto.randomUUID(), cardNo: createCardNo(), name, phone, visits: 0, stampProgress: 0,
        createdAt: new Date().toISOString(), consentAt: new Date().toISOString(),
        source: 'self-service', history: [],
      };
      const token = issueCardAccess(guest);
      db.guests.push(guest);
      writeDb();
      return send(res, 201, { card: publicGuest(guest), alreadyRegistered: false }, { 'Set-Cookie': cardAccessCookie(token, req) });
    } catch {
      return send(res, 400, { error: 'No pudimos crear la tarjeta. Verifica los datos e inténtalo de nuevo.' });
    }
  }

  if (method === 'POST' && pathname === '/api/stamp') {
    if (!originAllowed(req)) return send(res, 403, { error: 'Solicitud no permitida.' });
    if (!allowPublicRequest(req, 'stamp', 120)) return send(res, 429, { error: 'Has solicitado muchos sellos desde esta red. Inténtalo más tarde.' });
    try {
      const { phone: rawPhone } = await readJson(req);
      const phone = normalizePhone(rawPhone);
      if (phone.length < 7 || phone.length > 15) return send(res, 400, { error: 'Escribe un número de celular válido.' });
      const guest = db.guests.find((item) => item.phone === phone);
      if (!guest) return send(res, 404, { error: 'No encontramos una tarjeta con ese celular. Inscríbete primero con el QR de registro.' });
      const result = recordStamps(guest, { source: 'qr' });
      if (result.error) return send(res, 429, { error: result.nextAllowedAt ? 'Este sello ya fue registrado recientemente. Consulta con recepción si necesitas ayuda.' : result.error });
      return send(res, 201, { card: publicGuest(guest), events: result.events });
    } catch {
      return send(res, 400, { error: 'No pudimos registrar el sello. Verifica el celular e inténtalo de nuevo.' });
    }
  }

  if (method === 'GET' && pathname === '/api/admin/session') {
    if (!ADMIN_PASSWORD) return send(res, 503, { error: 'Falta configurar la clave de administración en el archivo .env.' });
    return send(res, 200, { authenticated: Boolean(sessionFrom(req)) });
  }

  if (method === 'POST' && pathname === '/api/admin/login') {
    if (!ADMIN_PASSWORD) return send(res, 503, { error: 'Configura ADMIN_PASSWORD antes de iniciar la app.' });
    if (!originAllowed(req)) return send(res, 403, { error: 'Solicitud no permitida.' });
    const ip = req.socket.remoteAddress || 'unknown';
    const attempts = loginAttempts.get(ip) || { count: 0, startedAt: Date.now() };
    if (Date.now() - attempts.startedAt > 15 * 60 * 1000) { attempts.count = 0; attempts.startedAt = Date.now(); }
    if (attempts.count >= 8) return send(res, 429, { error: 'Demasiados intentos. Espera 15 minutos e inténtalo de nuevo.' });
    try {
      const { password } = await readJson(req);
      const candidate = crypto.scryptSync(String(password || ''), PASSWORD_SALT, 64);
      if (!crypto.timingSafeEqual(candidate, PASSWORD_HASH)) {
        attempts.count += 1;
        loginAttempts.set(ip, attempts);
        return send(res, 401, { error: 'La contraseña no es correcta.' });
      }
      loginAttempts.delete(ip);
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, { expiresAt: Date.now() + SESSION_TTL });
      const secure = process.env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      return send(res, 200, { ok: true }, { 'Set-Cookie': `tonusco_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}${secure}` });
    } catch {
      return send(res, 400, { error: 'No pudimos iniciar sesión.' });
    }
  }

  if (method === 'POST' && pathname === '/api/admin/logout') {
    if (!originAllowed(req)) return send(res, 403, { error: 'Solicitud no permitida.' });
    const token = sessionFrom(req);
    if (token) sessions.delete(token);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'tonusco_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }

  if (pathname.startsWith('/api/admin/')) {
    if (!requireAdmin(req, res)) return;
    if (!originAllowed(req)) return send(res, 403, { error: 'Solicitud no permitida.' });

    const deleteHistoryMatch = pathname.match(/^\/api\/admin\/guests\/([a-f0-9-]+)\/history\/delete$/i);
    if (method === 'POST' && deleteHistoryMatch) {
      try {
        const { eventIds, confirmDelete } = await readJson(req);
        if (confirmDelete !== true) return send(res, 400, { error: 'Confirma que quieres eliminar los registros seleccionados.' });
        if (!Array.isArray(eventIds) || eventIds.length < 1 || eventIds.length > 100 || eventIds.some((id) => typeof id !== 'string' || id.length > 80) || new Set(eventIds).size !== eventIds.length) {
          return send(res, 400, { error: 'Selecciona entre 1 y 100 registros únicos del historial.' });
        }
        const guest = db.guests.find((item) => item.id === deleteHistoryMatch[1]);
        if (!guest) return send(res, 404, { error: 'No encontramos ese huésped.' });
        const selected = (guest.history || []).filter((item) => eventIds.includes(item.id) && !item.deletedAt);
        if (selected.length !== eventIds.length) return send(res, 409, { error: 'Algunos registros cambiaron. Actualiza el historial e inténtalo de nuevo.' });
        if (selected.some((item) => item.type === 'stamp' && (item.jacuzziEarned === true || item.jacuzziDelivered === true))) {
          return send(res, 409, { error: 'No se puede eliminar el sello asociado al beneficio del jacuzzi. Usa “Quitar sellos” para corregir el avance; el registro del beneficio se conservará.' });
        }

        const removedStamps = selected.filter((item) => item.type === 'stamp' && !item.voidedAt).length;
        const removedCheckouts = selected.filter((item) => item.type === 'checkout').length;
        const removedOther = selected.length - removedStamps - removedCheckouts;
        const deletedAt = new Date().toISOString();
        for (const item of selected) {
          item.deletedAt = deletedAt;
          item.deletedBy = 'reception';
        }
        if (removedStamps) {
          guest.stampProgress = Math.max(0, Math.min(Number(guest.stampProgress) || 0, STAMP_LIMIT) - removedStamps);
          guest.visits = Math.max(0, (Number(guest.visits) || 0) - removedStamps);
          const remainingStamps = (guest.history || []).filter((item) => item.type === 'stamp' && !item.voidedAt && !item.deletedAt)
            .sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || Number(a.stampNumber ?? a.visitNumber ?? 0) - Number(b.stampNumber ?? b.visitNumber ?? 0));
          if (remainingStamps.length === guest.stampProgress) {
            remainingStamps.forEach((item, index) => {
              const currentStamp = index + 1;
              item.stampNumber = currentStamp;
              item.visitNumber = currentStamp;
              item.discountAtArrival = reward(index);
              item.discountGranted = reward(currentStamp);
              item.nextReward = item.discountGranted;
            });
          }
          guest.lastStampAt = remainingStamps.map((item) => item.date).filter((value) => Number.isFinite(Date.parse(value)))
            .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
        }
        guest.updatedAt = deletedAt;
        writeDb();
        return send(res, 200, { guest: safeGuest(guest), removedCount: selected.length, removedStamps, removedCheckouts, removedOther });
      } catch {
        return send(res, 400, { error: 'No pudimos actualizar el historial.' });
      }
    }

    if (method === 'GET' && pathname === '/api/admin/guests') {
      const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
      const phoneQuery = normalizePhone(q);
      const guests = db.guests
        .filter((guest) => !q || guest.name.toLowerCase().includes(q) || String(guest.cardNo || '').toLowerCase().includes(q) || (phoneQuery && guest.phone.includes(phoneQuery)))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(safeGuest);
      return send(res, 200, { guests });
    }

    if (method === 'GET' && pathname === '/api/admin/stats') {
      const range = String(url.searchParams.get('range') || '30');
      const daysByRange = { '7': 7, '30': 30, '90': 90, '365': 365 };
      const days = daysByRange[range] || null;
      const now = Date.now();
      const periodStart = range === 'all' ? 0 : now - (days || 30) * 24 * 60 * 60 * 1000;
      const allEvents = [];
      const eventsByGuest = new Map();
      for (const guest of db.guests) {
        const guestEvents = [];
        for (const item of guest.history || []) {
          if (!Number.isFinite(Date.parse(item.date))) continue;
          if (item.type !== 'stamp' || item.voidedAt || item.deletedAt) continue;
          const event = {
            guestId: guest.id,
            time: Date.parse(item.date),
            date: item.date,
            discountGranted: Number(item.discountGranted ?? item.nextReward ?? Math.min((Number(item.visitNumber) || 0) * 5, 25)),
            jacuzziEarned: item.jacuzziEarned === true || (Number(item.discountGranted ?? item.nextReward) === 25 && Number(item.visitNumber) === STAMP_LIMIT),
            jacuzziDelivered: item.jacuzziDelivered === true,
          };
          guestEvents.push(event);
          allEvents.push(event);
        }
        guestEvents.sort((a, b) => a.time - b.time);
        eventsByGuest.set(guest.id, guestEvents);
      }
      const selectedEvents = allEvents.filter((item) => item.time >= periodStart);
      const periodGuests = new Set(selectedEvents.map((item) => item.guestId));
      const returningGuests = new Set([...periodGuests].filter((id) => (eventsByGuest.get(id) || []).length > 1));
      const repeatRate = periodGuests.size ? Math.round(returningGuests.size * 100 / periodGuests.size) : 0;
      const levels = [5, 10, 15, 20, 25];
      const stampsByLevel = Object.fromEntries(levels.map((level) => [level, selectedEvents.filter((item) => item.discountGranted === level).length]));
      const cardsByLevel = Object.fromEntries([0, ...levels].map((level) => [level, db.guests.filter((guest) => reward(guest.stampProgress) === level).length]));
      let totalGapDays = 0;
      let gapCount = 0;
      for (const guestEvents of eventsByGuest.values()) {
        for (let i = 1; i < guestEvents.length; i += 1) {
          const gap = (guestEvents[i].time - guestEvents[i - 1].time) / (24 * 60 * 60 * 1000);
          if (gap > 0) { totalGapDays += gap; gapCount += 1; }
        }
      }
      const jacuzziEvents = selectedEvents.filter((item) => item.jacuzziEarned);
      const bucketIsMonth = range === '365' || range === 'all';
      const bucketCount = bucketIsMonth ? 12 : (days || 30);
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now));
      const currentYear = Number(parts.find((item) => item.type === 'year')?.value);
      const currentMonth = Number(parts.find((item) => item.type === 'month')?.value);
      const currentDay = Number(parts.find((item) => item.type === 'day')?.value);
      const buckets = [];
      if (bucketIsMonth) {
        for (let index = bucketCount - 1; index >= 0; index -= 1) {
          const date = new Date(Date.UTC(currentYear, currentMonth - 1 - index, 1));
          const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
          const label = new Intl.DateTimeFormat('es-CO', { timeZone: 'UTC', month: 'short' }).format(date);
          buckets.push({ key, label, count: 0 });
        }
      } else {
        const firstDay = Date.UTC(currentYear, currentMonth - 1, currentDay - bucketCount + 1);
        for (let index = 0; index < bucketCount; index += 1) {
          const date = new Date(firstDay + index * 24 * 60 * 60 * 1000);
          const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
          const label = new Intl.DateTimeFormat('es-CO', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(date);
          buckets.push({ key, label, count: 0 });
        }
      }
      const bucketMap = new Map(buckets.map((bucket) => [bucket.key, bucket]));
      for (const item of selectedEvents) {
        const key = bucketIsMonth ? localDateKey(item.date).slice(0, 7) : localDateKey(item.date);
        const bucket = bucketMap.get(key);
        if (bucket) bucket.count += 1;
      }
      const newMembers = db.guests.filter((guest) => Date.parse(guest.createdAt) >= periodStart).length;
      return send(res, 200, {
        range,
        totalCustomers: db.guests.length,
        newMembers,
        visits: selectedEvents.length,
        customersWithVisits: periodGuests.size,
        returningCustomers: returningGuests.size,
        repeatRate,
        averageDaysBetweenVisits: gapCount ? Math.round(totalGapDays / gapCount) : null,
        stampsByLevel,
        cardsByLevel,
        jacuzziEarned: jacuzziEvents.length,
        jacuzziDelivered: jacuzziEvents.filter((item) => item.jacuzziDelivered).length,
        series: buckets,
      });
    }

    if (method === 'GET' && pathname === '/api/admin/export.csv') {
      const rows = [['Tarjeta', 'Nombre', 'Celular', 'Sellos', 'Descuento proxima visita', 'Ultimo sello', 'Creado']];
      for (const guest of db.guests) rows.push([guest.cardNo, guest.name, guest.phone, guest.stampProgress || 0, `${reward(guest.stampProgress)}%`, guest.lastStampAt || '', guest.createdAt]);
      const csv = '\uFEFF' + rows.map((row) => row.map(escapeCsv).join(',')).join('\r\n');
      return send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="tonusco-huespedes.csv"' });
    }

    if (method === 'POST' && pathname === '/api/admin/guests') {
      try {
        const { name: rawName, phone: rawPhone, consent } = await readJson(req);
        const name = String(rawName || '').trim().replace(/\s+/g, ' ');
        const phone = normalizePhone(rawPhone);
        if (name.length < 2 || name.length > 100) return send(res, 400, { error: 'Escribe un nombre válido.' });
        if (phone.length < 7 || phone.length > 15) return send(res, 400, { error: 'Escribe un número de celular válido.' });
        if (consent !== true) return send(res, 400, { error: 'Confirma que el huésped autorizó el uso de sus datos.' });
        let guest = db.guests.find((item) => item.phone === phone);
        if (guest) {
          guest.name = name;
          guest.consentAt = new Date().toISOString();
          guest.updatedAt = new Date().toISOString();
          writeDb();
          return send(res, 200, { guest: safeGuest(guest), updated: true });
        }
        guest = { id: crypto.randomUUID(), cardNo: createCardNo(), name, phone, visits: 0, stampProgress: 0, createdAt: new Date().toISOString(), consentAt: new Date().toISOString(), source: 'reception', history: [] };
        db.guests.push(guest);
        writeDb();
        return send(res, 201, { guest: safeGuest(guest), updated: false });
      } catch {
        return send(res, 400, { error: 'No pudimos guardar el huésped.' });
      }
    }

    const checkoutMatch = pathname.match(/^\/api\/admin\/guests\/([a-f0-9-]+)\/checkouts$/i);
    if (method === 'POST' && checkoutMatch) {
      try {
        const { discountRate = 0 } = await readJson(req);
        const guest = db.guests.find((item) => item.id === checkoutMatch[1]);
        if (!guest) return send(res, 404, { error: 'No encontramos ese huésped.' });
        const rate = Number(discountRate);
        if (![0, 5, 10, 15, 20, 25].includes(rate) || rate > reward(guest.stampProgress)) {
          return send(res, 400, { error: 'El descuento disponible de esta tarjeta cambió. Actualiza la búsqueda e inténtalo de nuevo.' });
        }
        const date = new Date().toISOString();
        const event = {
          id: crypto.randomUUID(), type: 'checkout', source: 'reception', date,
          discountAtArrival: rate,
        };
        guest.history = [...(guest.history || []), event];
        guest.updatedAt = date;
        writeDb();
        return send(res, 201, { guest: safeGuest(guest), event });
      } catch {
        return send(res, 400, { error: 'No pudimos guardar el check-out.' });
      }
    }

    const jacuzziMatch = pathname.match(/^\/api\/admin\/guests\/([a-f0-9-]+)\/jacuzzi-delivered$/i);
    if (method === 'POST' && jacuzziMatch) {
      const guest = db.guests.find((item) => item.id === jacuzziMatch[1]);
      if (!guest) return send(res, 404, { error: 'No encontramos ese huésped.' });
      const award = [...(guest.history || [])].reverse().find((item) => !item.deletedAt && (item.jacuzziEarned === true || (Number(item.nextReward ?? item.discountGranted) === 25 && Number(item.visitNumber) === STAMP_LIMIT)));
      if (!award) return send(res, 409, { error: 'Esta tarjeta todavía no tiene el beneficio de jacuzzi.' });
      if (award.jacuzziDelivered) return send(res, 409, { error: 'El beneficio de jacuzzi ya fue marcado como entregado.' });
      award.jacuzziEarned = true;
      award.jacuzziDelivered = true;
      award.jacuzziDeliveredAt = new Date().toISOString();
      writeDb();
      return send(res, 200, { guest: safeGuest(guest) });
    }

    const stampMatch = pathname.match(/^\/api\/admin\/guests\/([a-f0-9-]+)\/stamps\/manual$/i);
    if (method === 'POST' && stampMatch) {
      try {
        const { count = 1, jacuzziDelivered = false } = await readJson(req);
        const guest = db.guests.find((item) => item.id === stampMatch[1]);
        if (!guest) return send(res, 404, { error: 'No encontramos ese huésped.' });
        const result = recordStamps(guest, { source: 'reception', count, jacuzziDelivered, bypassCooldown: true });
        if (result.error) return send(res, 429, result);
        return send(res, 201, { guest: safeGuest(guest), events: result.events });
      } catch {
        return send(res, 400, { error: 'No pudimos registrar la estadía.' });
      }
    }

    const removeStampsMatch = pathname.match(/^\/api\/admin\/guests\/([a-f0-9-]+)\/stamps\/remove$/i);
    if (method === 'POST' && removeStampsMatch) {
      try {
        const { count = 1 } = await readJson(req);
        const guest = db.guests.find((item) => item.id === removeStampsMatch[1]);
        if (!guest) return send(res, 404, { error: 'No encontramos ese huésped.' });
        const progress = Math.min(Math.max(Math.floor(Number(guest.stampProgress) || 0), 0), STAMP_LIMIT);
        const numberToRemove = Number(count);
        if (!Number.isInteger(numberToRemove) || numberToRemove < 1) return send(res, 400, { error: 'Selecciona una cantidad válida de sellos.' });
        if (numberToRemove > progress) return send(res, 400, { error: `Esta tarjeta solo tiene ${progress} sellos para quitar.` });

        const activeEvents = (guest.history || []).filter((item) => item.type === 'stamp' && !item.voidedAt && !item.deletedAt)
          .sort((a, b) => Number(b.stampNumber ?? b.visitNumber ?? 0) - Number(a.stampNumber ?? a.visitNumber ?? 0) || Date.parse(b.date) - Date.parse(a.date));
        const affectedEvents = activeEvents.slice(0, numberToRemove);
        const date = new Date().toISOString();
        const stampNumbers = Array.from({ length: numberToRemove }, (_, index) => progress - numberToRemove + index + 1);
        for (const item of affectedEvents) {
          item.voidedAt = date;
          item.voidedBy = 'reception';
        }
        guest.stampProgress = progress - numberToRemove;
        guest.visits = Math.max(0, (Number(guest.visits) || 0) - numberToRemove);
        const remainingStamps = (guest.history || []).filter((item) => item.type === 'stamp' && !item.voidedAt && !item.deletedAt);
        guest.lastStampAt = remainingStamps.map((item) => item.date).filter((value) => Number.isFinite(Date.parse(value)))
          .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
        guest.history = [...(guest.history || []), {
          id: crypto.randomUUID(), type: 'adjustment', action: 'remove_stamps', source: 'reception', date,
          count: numberToRemove, stampNumbers,
        }];
        guest.updatedAt = date;
        writeDb();
        return send(res, 200, { guest: safeGuest(guest), removedCount: numberToRemove });
      } catch {
        return send(res, 400, { error: 'No pudimos quitar los sellos.' });
      }
    }
    return send(res, 404, { error: 'No encontramos esa opción.' });
  }
  return null;
}

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webmanifest': 'application/manifest+json; charset=utf-8' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/wallet/')) {
      const result = await api(req, res, url);
      if (result !== null) return;
      return send(res, 404, { error: 'No encontramos esa opción.' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Método no permitido.');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '/registro' || pathname === '/sello') pathname = '/index.html';
    const allowed = new Set(['/index.html', '/logo-tonusco.jpg', '/favicon.ico', '/manifest.webmanifest', '/service-worker.js', '/icon-tonusco.svg', '/icon-tonusco-192.png', '/icon-tonusco-512.png', '/videos/guia-inicio-android.mp4', '/videos/guia-inicio-iphone.mp4']);
    if (!allowed.has(pathname)) return send(res, 404, 'Página no encontrada.');
    const file = path.join(ROOT, pathname.slice(1));
    if (!fs.existsSync(file)) return send(res, 404, 'Página no encontrada.');
    const extension = path.extname(file);
    const stat = fs.statSync(file);
    const headers = { 'Content-Type': mime[extension] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https://api.qrserver.com; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'" };
    if (extension === '.mp4') {
      headers['Accept-Ranges'] = 'bytes';
      const range = req.headers.range;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (!match) {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
          return res.end();
        }
        let start;
        let end;
        if (match[1] === '') {
          const suffixLength = Number(match[2]);
          if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
            res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
            return res.end();
          }
          start = Math.max(stat.size - suffixLength, 0);
          end = stat.size - 1;
        } else {
          start = Number(match[1]);
          end = match[2] === '' ? stat.size - 1 : Number(match[2]);
        }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= stat.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
          return res.end();
        }
        end = Math.min(end, stat.size - 1);
        headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
        headers['Content-Length'] = String(end - start + 1);
        res.writeHead(206, headers);
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
    }
    headers['Content-Length'] = String(stat.size);
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) send(res, 500, { error: 'Ocurrió un error interno.' });
    else res.destroy();
  }
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  console.log(`Club Tonusco disponible en http://localhost:${address.port}`);
  if (!ADMIN_PASSWORD) console.error('Falta ADMIN_PASSWORD: configura esa variable en .env para habilitar la administración.');
  console.log(`Datos persistentes: ${DATA_FILE}`);
});

function stop() {
  server.close(() => process.exit(0));
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
