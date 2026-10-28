const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const multer = require('multer');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MAX_FILE_MB = 50;
const EXPIRY_MS = 2 * 60 * 60 * 1000; // 2h inactivity
const UPLOAD_ROOT = path.join(__dirname, 'uploads');
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing 0/O/1/I

fs.rmSync(UPLOAD_ROOT, { recursive: true, force: true }); // clean leftovers on boot
fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

const app = express();
app.set('trust proxy', 1); // behind Render/Cloudflare etc., so req.protocol becomes https
const server = http.createServer(app);
const io = new Server(server);

// code -> { createdAt, lastActive, texts: [], files: [] }
const sessions = new Map();

function newCode() {
  let code;
  do {
    code = Array.from(crypto.randomBytes(6), b => CODE_CHARS[b % CODE_CHARS.length]).join('');
  } while (sessions.has(code));
  return code;
}
const id = () => crypto.randomBytes(6).toString('hex');
const touch = s => { s.lastActive = Date.now(); };
const publicState = s => ({ texts: s.texts, files: s.files, expiresAt: s.lastActive + EXPIRY_MS });

function destroySession(code, reason = 'deleted') {
  const s = sessions.get(code);
  if (!s) return;
  sessions.delete(code);
  fs.rmSync(path.join(UPLOAD_ROOT, code), { recursive: true, force: true });
  io.to(code).emit('session-ended', reason);
  io.in(code).disconnectSockets(true);
}

// Auto-expiry sweep
setInterval(() => {
  const now = Date.now();
  for (const [code, s] of sessions) if (now - s.lastActive > EXPIRY_MS) destroySession(code, 'expired');
}, 60 * 1000);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function getLanUrl(req) {
  // Use the request host if it's not localhost; otherwise find a LAN IP so a phone can reach it
  const host = req.headers.host || '';
  if (!/^(localhost|127\.)/.test(host)) return `${req.protocol}://${host}`;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list) if (n.family === 'IPv4' && !n.internal) return `http://${n.address}:${PORT}`;
  }
  return `${req.protocol}://${host}`;
}

app.post('/api/sessions', (req, res) => {
  const code = newCode();
  sessions.set(code, { createdAt: Date.now(), lastActive: Date.now(), texts: [], files: [] });
  fs.mkdirSync(path.join(UPLOAD_ROOT, code), { recursive: true });
  res.json({ code });
});

app.get('/api/sessions/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  res.json({ exists: sessions.has(code) });
});

app.get('/api/sessions/:code/qr', async (req, res) => {
  const code = req.params.code.toUpperCase();
  if (!sessions.has(code)) return res.status(404).json({ error: 'not found' });
  const joinUrl = `${getLanUrl(req)}/s/${code}`;
  const qr = await QRCode.toDataURL(joinUrl, { margin: 1, width: 280 });
  res.json({ joinUrl, qr });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const code = req.params.code.toUpperCase();
      if (!sessions.has(code)) return cb(new Error('no session'));
      cb(null, path.join(UPLOAD_ROOT, code));
    },
    filename: (req, file, cb) => cb(null, id()),
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
});

app.post('/api/sessions/:code/files', (req, res) => {
  const code = req.params.code.toUpperCase();
  const s = sessions.get(code);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  upload.array('files', 20)(req, res, err => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `File too large (max ${MAX_FILE_MB} MB)` : err.message;
      return res.status(400).json({ error: msg });
    }
    const added = (req.files || []).map(f => ({
      id: f.filename,
      name: Buffer.from(f.originalname, 'latin1').toString('utf8'),
      size: f.size,
      addedAt: Date.now(),
    }));
    s.files.push(...added);
    touch(s);
    added.forEach(f => io.to(code).emit('file-added', f));
    res.json({ ok: true, added });
  });
});

app.get('/api/sessions/:code/files/:fileId', (req, res) => {
  const code = req.params.code.toUpperCase();
  const s = sessions.get(code);
  const f = s && s.files.find(x => x.id === req.params.fileId);
  if (!f) return res.status(404).send('Not found');
  touch(s);
  res.download(path.join(UPLOAD_ROOT, code, f.id), f.name);
});

io.on('connection', socket => {
  let code = null;

  socket.on('join-session', (raw, deviceName, cb) => {
    const c = String(raw || '').toUpperCase();
    const s = sessions.get(c);
    if (!s) return cb && cb({ error: 'Session not found' });
    code = c;
    socket.data.device = String(deviceName || 'Device').slice(0, 30);
    socket.join(code);
    touch(s);
    cb && cb({ ok: true, state: publicState(s) });
    broadcastDevices(code);
  });

  socket.on('add-text', (text, cb) => {
    const s = sessions.get(code);
    if (!s) return;
    text = String(text || '').slice(0, 100000);
    if (!text.trim()) return;
    const item = { id: id(), text, from: socket.data.device, addedAt: Date.now() };
    s.texts.push(item);
    touch(s);
    io.to(code).emit('text-added', item);
    cb && cb({ ok: true });
  });

  socket.on('delete-text', itemId => {
    const s = sessions.get(code);
    if (!s) return;
    s.texts = s.texts.filter(t => t.id !== itemId);
    touch(s);
    io.to(code).emit('text-deleted', itemId);
  });

  socket.on('delete-file', itemId => {
    const s = sessions.get(code);
    if (!s) return;
    const f = s.files.find(x => x.id === itemId);
    if (!f) return;
    fs.rmSync(path.join(UPLOAD_ROOT, code, f.id), { force: true });
    s.files = s.files.filter(x => x.id !== itemId);
    touch(s);
    io.to(code).emit('file-deleted', itemId);
  });

  socket.on('delete-session', () => { if (code) destroySession(code, 'deleted'); });

  socket.on('disconnect', () => { if (code && sessions.has(code)) broadcastDevices(code); });
});

async function broadcastDevices(code) {
  const sockets = await io.in(code).fetchSockets();
  io.to(code).emit('devices', sockets.map(s => s.data.device));
}

// SPA-style route for QR links
app.get('/s/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'session.html')));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`ShareBridge running:  http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const n of list) if (n.family === 'IPv4' && !n.internal) console.log(`On your network:      http://${n.address}:${PORT}`);
});
