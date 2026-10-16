import express from 'express';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { AccessToken } from 'livekit-server-sdk';
import { db, publicChannel, publicMessage, publicUser } from './db.js';
import {
  createSession,
  createUser,
  deleteOtherSessions,
  deleteSession,
  findUserRow,
  getUser,
  rateLimited,
  setPassword,
  userFromToken,
  validateCredentials,
  verifyPassword,
} from './auth.js';

const root = process.env.MINICORD_HOME || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.PORT || 666);
const INVITE_CODE = process.env.INVITE_CODE || '';
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const LIVEKIT_URL = process.env.LIVEKIT_URL || '';
const LIVEKIT_LOCAL = process.env.LIVEKIT_LOCAL !== 'false';

if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  console.error('Faltam LIVEKIT_API_KEY/LIVEKIT_API_SECRET no .env. Rode "npm run setup" primeiro.');
  process.exit(1);
}

// ---------- LiveKit local (opcional) ----------
let livekitProcess = null;
if (LIVEKIT_LOCAL) {
  const exe = resolve(root, 'livekit', process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server');
  const config = resolve(root, 'livekit', 'livekit.yaml');
  if (existsSync(exe) && existsSync(config)) {
    // Os logs do LiveKit vão para data/livekit.log para não poluir o terminal.
    mkdirSync(resolve(root, 'data'), { recursive: true });
    const log = openSync(resolve(root, 'data', 'livekit.log'), 'a');
    livekitProcess = spawn(exe, ['--config', config], { stdio: ['ignore', log, log] });
    livekitProcess.on('exit', (code) => {
      if (code) console.error(`[livekit] encerrou com erro (código ${code}). Veja data/livekit.log`);
    });
    console.log('[livekit] servidor de mídia local iniciado na porta 7880');
  } else {
    console.warn('[livekit] binário ou livekit.yaml não encontrado; rode "npm run setup".');
  }
}
const shutdown = () => {
  livekitProcess?.kill();
  process.exit(0);
};
process.on('exit', () => livekitProcess?.kill());
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---------- HTTP ----------
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '100kb' }));

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const user = userFromToken(token);
  if (!user) return res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
  req.user = user;
  req.token = token;
  next();
}

app.get('/api/config', (_req, res) => {
  res.json({ inviteRequired: !!INVITE_CODE });
});

app.post('/api/register', (req, res) => {
  if (rateLimited(`reg:${req.ip}`)) return res.status(429).json({ error: 'Muitas tentativas. Tente mais tarde.' });
  const { username, password, inviteCode } = req.body || {};
  if (INVITE_CODE && inviteCode !== INVITE_CODE) return res.status(403).json({ error: 'Código de convite inválido.' });
  const problem = validateCredentials(username, password);
  if (problem) return res.status(400).json({ error: problem });
  if (findUserRow(username)) return res.status(409).json({ error: 'Esse usuário já existe.' });
  const user = createUser(username, password);
  broadcastUsers();
  res.json({ token: createSession(user.id), user });
});

app.post('/api/login', (req, res) => {
  if (rateLimited(`login:${req.ip}`)) return res.status(429).json({ error: 'Muitas tentativas. Tente mais tarde.' });
  const { username, password } = req.body || {};
  const row = typeof username === 'string' && typeof password === 'string' ? findUserRow(username) : null;
  if (!row || !verifyPassword(password, row.password_hash)) {
    return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  }
  res.json({ token: createSession(row.id), user: publicUser(row) });
});

app.post('/api/logout', auth, (req, res) => {
  deleteSession(req.token);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));

app.patch('/api/me', auth, (req, res) => {
  const { displayName, color } = req.body || {};
  if (displayName !== undefined) {
    const name = String(displayName).trim();
    if (name.length < 1 || name.length > 32) return res.status(400).json({ error: 'Nome deve ter de 1 a 32 caracteres.' });
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, req.user.id);
  }
  if (color !== undefined) {
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) return res.status(400).json({ error: 'Cor inválida.' });
    db.prepare('UPDATE users SET color = ? WHERE id = ?').run(color, req.user.id);
  }
  broadcastUsers();
  res.json({ user: getUser(req.user.id) });
});

app.post('/api/me/password', auth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (typeof currentPassword !== 'string' || !verifyPassword(currentPassword, row.password_hash)) {
    return res.status(401).json({ error: 'Senha atual incorreta.' });
  }
  const problem = validateCredentials(req.user.username, newPassword);
  if (problem) return res.status(400).json({ error: problem });
  setPassword(req.user.id, newPassword);
  deleteOtherSessions(req.user.id, req.token);
  res.json({ ok: true });
});

app.post('/api/voice-token', auth, async (req, res) => {
  const channel = db.prepare("SELECT * FROM channels WHERE id = ? AND type = 'voice'").get(Number(req.body?.channelId));
  if (!channel) return res.status(404).json({ error: 'Sala de voz não encontrada.' });
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: String(req.user.id),
    name: req.user.displayName,
    ttl: '12h',
  });
  at.addGrant({ roomJoin: true, room: `channel-${channel.id}`, canPublish: true, canSubscribe: true, canPublishData: true });
  // Sem LIVEKIT_URL configurado, usa o mesmo host do site (funciona em rede local / Tailscale).
  const url = LIVEKIT_URL || `ws://${req.hostname}:7880`;
  res.json({ token: await at.toJwt(), url });
});

const clientDist = resolve(root, 'client', 'dist');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/(api|socket\.io)\b).*/, (_req, res) => res.sendFile(resolve(clientDist, 'index.html')));
} else {
  app.get('/', (_req, res) => res.send('Interface não compilada. Rode "npm run build".'));
}

// ---------- Tempo real ----------
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });

/** voiceStates: socketId -> { userId, channelId, muted, deafened, video, screen } */
const voiceStates = new Map();
/** online: userId -> IDs das conexões Socket.IO abertas */
const online = new Map();

const allUsers = () => db.prepare('SELECT * FROM users ORDER BY display_name COLLATE NOCASE').all().map(publicUser);
const allChannels = () => db.prepare('SELECT * FROM channels ORDER BY type DESC, id').all().map(publicChannel);
const onlineIds = () => [...online].filter(([, sockets]) => sockets.size > 0).map(([userId]) => userId);

function voiceSnapshot() {
  const byChannel = {};
  const seen = new Set();
  for (const s of voiceStates.values()) {
    // Um usuário com duas janelas abertas aparece só uma vez.
    const key = `${s.channelId}:${s.userId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (byChannel[s.channelId] ||= []).push({ ...s });
  }
  return byChannel;
}

const broadcastUsers = () => io.emit('users', { users: allUsers(), online: onlineIds() });
const broadcastChannels = () => io.emit('channels', allChannels());
const broadcastVoice = () => io.emit('voice:states', voiceSnapshot());

io.use((socket, next) => {
  const user = userFromToken(socket.handshake.auth?.token);
  if (!user) return next(new Error('unauthorized'));
  socket.data.userId = user.id;
  next();
});

io.on('connection', (socket) => {
  const userId = socket.data.userId;
  const me = () => getUser(userId);
  const sockets = online.get(userId) || new Set();
  sockets.add(socket.id);
  online.set(userId, sockets);
  socket.join(`user:${userId}`);

  socket.emit('init', {
    me: me(),
    users: allUsers(),
    online: onlineIds(),
    channels: allChannels(),
    voice: voiceSnapshot(),
  });
  broadcastUsers();

  const wrap = (fn) => async (payload, ack) => {
    try {
      const result = await fn(payload || {});
      if (typeof ack === 'function') ack({ ok: true, ...result });
    } catch (err) {
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  };

  socket.on('channel:create', wrap(({ name, type }) => {
    const clean = String(name || '').trim().slice(0, 40);
    if (!clean) throw new Error('Dê um nome para a sala.');
    if (!['text', 'voice'].includes(type)) throw new Error('Tipo inválido.');
    const finalName = type === 'text' ? clean.toLowerCase().replace(/\s+/g, '-') : clean;
    const r = db.prepare('INSERT INTO channels (name, type, created_by, created_at) VALUES (?, ?, ?, ?)').run(finalName, type, userId, Date.now());
    broadcastChannels();
    return { id: Number(r.lastInsertRowid) };
  }));

  socket.on('channel:rename', wrap(({ id, name }) => {
    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(Number(id));
    if (!channel) throw new Error('Sala não encontrada.');
    if (channel.created_by !== userId && !me().isAdmin) throw new Error('Só quem criou a sala (ou o admin) pode renomear.');
    let clean = String(name || '').trim().slice(0, 40);
    if (!clean) throw new Error('Dê um nome para a sala.');
    if (channel.type === 'text') clean = clean.toLowerCase().replace(/\s+/g, '-');
    db.prepare('UPDATE channels SET name = ? WHERE id = ?').run(clean, channel.id);
    broadcastChannels();
  }));

  socket.on('channel:delete', wrap(({ id }) => {
    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(Number(id));
    if (!channel) throw new Error('Sala não encontrada.');
    if (channel.created_by !== userId && !me().isAdmin) throw new Error('Só quem criou a sala (ou o admin) pode apagar.');
    db.prepare('DELETE FROM channels WHERE id = ?').run(channel.id);
    for (const [sid, s] of voiceStates) if (s.channelId === channel.id) voiceStates.delete(sid);
    broadcastChannels();
    broadcastVoice();
  }));

  socket.on('messages:fetch', wrap(({ channelId, before }) => {
    const rows = before
      ? db.prepare('SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT 50').all(Number(channelId), Number(before))
      : db.prepare('SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT 50').all(Number(channelId));
    return { messages: rows.reverse().map(publicMessage), hasMore: rows.length === 50 };
  }));

  socket.on('message:send', wrap(({ channelId, content }) => {
    const text = String(content || '').trim();
    if (!text) throw new Error('Mensagem vazia.');
    if (text.length > 4000) throw new Error('Mensagem muito longa (máx. 4000 caracteres).');
    const channel = db.prepare("SELECT id FROM channels WHERE id = ? AND type = 'text'").get(Number(channelId));
    if (!channel) throw new Error('Sala não encontrada.');
    const r = db.prepare('INSERT INTO messages (channel_id, user_id, content, created_at) VALUES (?, ?, ?, ?)').run(channel.id, userId, text, Date.now());
    const msg = publicMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(r.lastInsertRowid)));
    io.emit('message:new', msg);
    return { message: msg };
  }));

  socket.on('message:delete', wrap(({ id }) => {
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(id));
    if (!msg) throw new Error('Mensagem não encontrada.');
    if (msg.user_id !== userId && !me().isAdmin) throw new Error('Você só pode apagar suas mensagens.');
    db.prepare('DELETE FROM messages WHERE id = ?').run(msg.id);
    io.emit('message:deleted', { id: msg.id, channelId: msg.channel_id });
  }));

  socket.on('typing', ({ channelId } = {}) => {
    socket.broadcast.emit('typing', { channelId: Number(channelId), userId });
  });

  socket.on('voice:join', wrap(({ channelId }) => {
    const channel = db.prepare("SELECT id FROM channels WHERE id = ? AND type = 'voice'").get(Number(channelId));
    if (!channel) throw new Error('Sala de voz não encontrada.');
    // Entrar por outra janela tira o usuário da sala anterior (o LiveKit também derruba a conexão antiga).
    for (const [sid, s] of voiceStates) if (s.userId === userId) voiceStates.delete(sid);
    voiceStates.set(socket.id, { userId, channelId: channel.id, muted: false, deafened: false, video: false, screen: false });
    broadcastVoice();
  }));

  socket.on('voice:update', (patch = {}) => {
    const s = voiceStates.get(socket.id);
    if (!s) return;
    for (const k of ['muted', 'deafened', 'video', 'screen']) if (typeof patch[k] === 'boolean') s[k] = patch[k];
    broadcastVoice();
  });

  socket.on('voice:leave', () => {
    if (voiceStates.delete(socket.id)) broadcastVoice();
  });

  socket.on('disconnect', () => {
    const sockets = online.get(userId);
    if (sockets?.delete(socket.id) && sockets.size === 0) online.delete(userId);
    if (voiceStates.delete(socket.id)) broadcastVoice();
    broadcastUsers();
  });
});

server.listen(PORT, () => {
  console.log(`Concord rodando em http://localhost:${PORT}`);
  if (INVITE_CODE) console.log(`Código de convite para criar contas: ${INVITE_CODE}`);
});
