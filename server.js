'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
loadEnv(path.join(ROOT, '.env'));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DATA_FILE = path.resolve(process.env.DATA_FILE || path.join(ROOT, 'data', 'tonusco.json'));
const SESSION_TTL = 12 * 60 * 60 * 1000;
const STAMP_COOLDOWN_MS = 48 * 60 * 60 * 1000;
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
function reward(visits) { return Math.min(Math.max(Number(visits) || 0, 0) * 5, 25); }
function createCardNo(guests = db.guests) {
  const used = new Set(guests.map((guest) => String(guest.cardNo || '')));
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const value = String(crypto.randomInt(100, 1000));
    if (!used.has(value)) return value;
  }
  return String(crypto.randomInt(100000, 1000000));
}
function mostRecentStamp(guest) {
  const dates = [guest.lastStampAt, ...(guest.history || []).map((event) => event.date)]
    .filter(Boolean).map((value) => Date.parse(value)).filter(Number.isFinite);
  return dates.length ? Math.max(...dates) : 0;
}
function recordStamp(guest, { source, discountUsed = null }) {
  const now = Date.now();
  const last = mostRecentStamp(guest);
  if (last && now - last < STAMP_COOLDOWN_MS) {
    const next = last + STAMP_COOLDOWN_MS;
    const date = new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Bogota' }).format(new Date(next));
    return { error: `Esta tarjeta ya recibió un sello. Podrá recibir el siguiente el ${date}.`, nextAllowedAt: new Date(next).toISOString() };
  }
  const previousReward = reward(guest.visits);
  guest.visits = (Number(guest.visits) || 0) + 1;
  const date = new Date(now).toISOString();
  const event = {
    id: crypto.randomUUID(), type: 'stamp', source, date,
    visitNumber: guest.visits,
    discountAtArrival: previousReward,
    discountUsed: previousReward > 0 && source !== 'qr' ? Boolean(discountUsed) : null,
    nextReward: reward(guest.visits),
  };
  guest.history = [...(guest.history || []), event];
  guest.lastStampAt = date;
  guest.updatedAt = date;
  writeDb();
  return { event };
}
function publicGuest(guest) {
  return { name: guest.name, cardNo: guest.cardNo, visits: guest.visits, reward: reward(guest.visits) };
}
function escapeCsv(value) { return `"${String(value ?? '').replace(/"/g, '""')}"`; }

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
  return {
    id: guest.id,
    cardNo: guest.cardNo,
    name: guest.name,
    phone: guest.phone,
    visits: guest.visits,
    reward: reward(guest.visits),
    createdAt: guest.createdAt,
    lastStampAt: guest.lastStampAt || null,
    history: (guest.history || []).slice(-8).reverse(),
  };
}

async function api(req, res, url) {
  const method = req.method;
  const pathname = url.pathname;
  if (method === 'GET' && pathname === '/api/health') return send(res, 200, { ok: true });

  if (method === 'POST' && pathname === '/api/card') {
    if (!allowPublicRequest(req, 'card', 120)) return send(res, 429, { error: 'Has hecho muchas consultas. Inténtalo más tarde.' });
    try {
      const { phone: rawPhone } = await readJson(req);
      const phone = normalizePhone(rawPhone);
      if (phone.length < 7 || phone.length > 15) return send(res, 400, { error: 'Escribe un número de celular válido.' });
      const guest = db.guests.find((item) => item.phone === phone);
      if (!guest) return send(res, 404, { error: 'No encontramos una tarjeta con ese número.' });
      return send(res, 200, { card: publicGuest(guest) });
    } catch {
      return send(res, 400, { error: 'No pudimos consultar la tarjeta. Intenta de nuevo.' });
    }
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
      if (existing) return send(res, 200, { card: publicGuest(existing), alreadyRegistered: true });
      const guest = {
        id: crypto.randomUUID(), cardNo: createCardNo(), name, phone, visits: 0,
        createdAt: new Date().toISOString(), consentAt: new Date().toISOString(),
        source: 'self-service', history: [],
      };
      db.guests.push(guest);
      writeDb();
      return send(res, 201, { card: publicGuest(guest), alreadyRegistered: false });
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
      const result = recordStamp(guest, { source: 'qr' });
      if (result.error) return send(res, 429, result);
      return send(res, 201, { card: publicGuest(guest), event: result.event });
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

    if (method === 'GET' && pathname === '/api/admin/guests') {
      const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
      const phoneQuery = normalizePhone(q);
      const guests = db.guests
        .filter((guest) => !q || guest.name.toLowerCase().includes(q) || (phoneQuery && guest.phone.includes(phoneQuery)))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(safeGuest);
      return send(res, 200, { guests });
    }

    if (method === 'GET' && pathname === '/api/admin/export.csv') {
      const rows = [['Tarjeta', 'Nombre', 'Celular', 'Sellos', 'Descuento proxima visita', 'Ultimo sello', 'Creado']];
      for (const guest of db.guests) rows.push([guest.cardNo, guest.name, guest.phone, guest.visits, `${reward(guest.visits)}%`, guest.lastStampAt || '', guest.createdAt]);
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
        guest = { id: crypto.randomUUID(), cardNo: createCardNo(), name, phone, visits: 0, createdAt: new Date().toISOString(), consentAt: new Date().toISOString(), source: 'reception', history: [] };
        db.guests.push(guest);
        writeDb();
        return send(res, 201, { guest: safeGuest(guest), updated: false });
      } catch {
        return send(res, 400, { error: 'No pudimos guardar el huésped.' });
      }
    }

    const stampMatch = pathname.match(/^\/api\/admin\/guests\/([a-f0-9-]+)\/stamps\/manual$/i);
    if (method === 'POST' && stampMatch) {
      try {
        const { discountUsed = false } = await readJson(req);
        const guest = db.guests.find((item) => item.id === stampMatch[1]);
        if (!guest) return send(res, 404, { error: 'No encontramos ese huésped.' });
        const result = recordStamp(guest, { source: 'reception', discountUsed });
        if (result.error) return send(res, 429, result);
        return send(res, 201, { guest: safeGuest(guest), event: result.event });
      } catch {
        return send(res, 400, { error: 'No pudimos registrar la estadía.' });
      }
    }
    return send(res, 404, { error: 'No encontramos esa opción.' });
  }
  return null;
}

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      const result = await api(req, res, url);
      if (result !== null) return;
      return send(res, 404, { error: 'No encontramos esa opción.' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Método no permitido.');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '/registro' || pathname === '/sello') pathname = '/index.html';
    const allowed = new Set(['/index.html', '/logo-tonusco.jpg', '/favicon.ico']);
    if (!allowed.has(pathname)) return send(res, 404, 'Página no encontrada.');
    const file = path.join(ROOT, pathname.slice(1));
    if (!fs.existsSync(file)) return send(res, 404, 'Página no encontrada.');
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https://api.qrserver.com; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'" });
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
