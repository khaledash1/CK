// server.js — Layl Chat v2 : HTTP + WebSocket + إشارات WebRTC الصوتية
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import * as cookie from 'cookie';
import { fileURLToPath } from 'url';
import path from 'path';
import db from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'layl-dev-secret-change-me-in-production';
const PROD = process.env.NODE_ENV === 'production';

const now = () => Date.now();
const clamp = (s, n) => String(s ?? '').slice(0, n);
const levelFromXp = (xp) => Math.max(1, Math.floor(0.25 * Math.sqrt(xp)) + 1);
const xpForLevel = (lv) => Math.pow((lv - 1) / 0.25, 2);
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const EMOJI_SET = ['❤️', '🔥', '😂', '👍', '😮', '😢', '🙏', '🌙'];
const COUNTRIES = ['SA','AE','KW','QA','BH','OM','YE','EG','JO','IQ','SY','LB','PS','MA','DZ','TN','LY','SD','OTHER'];

function signToken(user) { return jwt.sign({ id: user.id, u: user.username }, JWT_SECRET, { expiresIn: '30d' }); }
function safeJSON(s, d) { try { return JSON.parse(s); } catch { return d; } }
function userPublic(u) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, display: u.display, avatar: u.avatar, color: u.color,
    bio: u.bio, vibe: u.vibe, country: u.country, social: safeJSON(u.social, {}),
    role: u.role, xp: u.xp, level: u.level, likes: u.likes,
    nextLevelXp: Math.ceil(xpForLevel(u.level + 1)), thisLevelXp: Math.ceil(xpForLevel(u.level)),
  };
}

const Q = {
  userByName: db.prepare('SELECT * FROM users WHERE username=?'),
  userById: db.prepare('SELECT * FROM users WHERE id=?'),
  createUser: db.prepare(`INSERT INTO users(username,display,pass_hash,avatar,color,country,role,created_at)
                          VALUES(@username,@display,@pass_hash,@avatar,@color,@country,@role,@created_at)`),
  countUsers: db.prepare('SELECT COUNT(*) c FROM users'),
  updateProfile: db.prepare('UPDATE users SET display=?, avatar=?, color=?, bio=?, vibe=?, country=?, social=? WHERE id=?'),
  addXp: db.prepare('UPDATE users SET xp=xp+?, level=? WHERE id=?'),
  setRole: db.prepare('UPDATE users SET role=? WHERE id=?'),
  setBan: db.prepare('UPDATE users SET banned=? WHERE id=?'),
  setMute: db.prepare('UPDATE users SET muted_until=? WHERE id=?'),
  incLikes: db.prepare('UPDATE users SET likes=likes+? WHERE id=?'),

  rooms: db.prepare('SELECT * FROM rooms ORDER BY id'),
  roomBySlug: db.prepare('SELECT * FROM rooms WHERE slug=?'),
  roomById: db.prepare('SELECT * FROM rooms WHERE id=?'),
  createRoom: db.prepare(`INSERT INTO rooms(slug,name,topic,icon,kind,capacity,seats,welcome,owner_id,created_at)
                          VALUES(?,?,?,?,?,?,?,?,?,?)`),

  insMsg: db.prepare('INSERT INTO messages(room_id,user_id,body,reply_to,kind,created_at) VALUES(?,?,?,?,?,?)'),
  msgById: db.prepare('SELECT * FROM messages WHERE id=?'),
  editMsg: db.prepare('UPDATE messages SET body=?, edited=1 WHERE id=?'),
  delMsg: db.prepare("UPDATE messages SET deleted=1, body='' WHERE id=?"),
  recentMsgs: db.prepare('SELECT * FROM messages WHERE room_id=? AND id < ? ORDER BY id DESC LIMIT ?'),
  searchMsgs: db.prepare(`SELECT * FROM messages WHERE room_id=? AND deleted=0 AND body LIKE ? ORDER BY id DESC LIMIT 40`),

  addReaction: db.prepare('INSERT OR IGNORE INTO reactions(message_id,user_id,emoji) VALUES(?,?,?)'),
  delReaction: db.prepare('DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?'),
  reactionsFor: db.prepare('SELECT emoji, COUNT(*) c FROM reactions WHERE message_id=? GROUP BY emoji'),
  myReactions: db.prepare('SELECT emoji FROM reactions WHERE message_id=? AND user_id=?'),

  insDM: db.prepare('INSERT INTO dms(from_id,to_id,body,created_at) VALUES(?,?,?,?)'),
  dmThread: db.prepare(`SELECT * FROM dms WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?) ORDER BY id DESC LIMIT 50`),
  dmSeen: db.prepare('UPDATE dms SET seen=1 WHERE to_id=? AND from_id=?'),
  dmInbox: db.prepare(`SELECT from_id, COUNT(*) c FROM dms WHERE to_id=? AND seen=0 GROUP BY from_id`),

  liked: db.prepare('SELECT 1 FROM user_likes WHERE liker_id=? AND target_id=?'),
  addLike: db.prepare('INSERT OR IGNORE INTO user_likes(liker_id,target_id,created_at) VALUES(?,?,?)'),
  delLike: db.prepare('DELETE FROM user_likes WHERE liker_id=? AND target_id=?'),

  wallList: db.prepare('SELECT * FROM wall_posts ORDER BY id DESC LIMIT 40'),
  wallInsert: db.prepare('INSERT INTO wall_posts(user_id,body,created_at) VALUES(?,?,?)'),
  wallById: db.prepare('SELECT * FROM wall_posts WHERE id=?'),
  wallDelete: db.prepare('DELETE FROM wall_posts WHERE id=?'),
  wallLike: db.prepare('INSERT OR IGNORE INTO wall_likes(post_id,user_id) VALUES(?,?)'),
  wallUnlike: db.prepare('DELETE FROM wall_likes WHERE post_id=? AND user_id=?'),
  wallLikeCount: db.prepare('SELECT COUNT(*) c FROM wall_likes WHERE post_id=?'),
  wallLikedByMe: db.prepare('SELECT 1 FROM wall_likes WHERE post_id=? AND user_id=?'),
};

function reactionSummary(msgId, meId) {
  const counts = Q.reactionsFor.all(msgId);
  const mine = new Set(Q.myReactions.all(msgId, meId || 0).map(r => r.emoji));
  return counts.map(r => ({ emoji: r.emoji, count: r.c, mine: mine.has(r.emoji) }));
}
function miniUser(u) {
  return u ? { id: u.id, display: u.display, avatar: u.avatar, color: u.color, role: u.role, level: u.level, country: u.country } : null;
}
function hydrateMsg(m, meId) {
  const author = m.user_id ? Q.userById.get(m.user_id) : null;
  let reply = null;
  if (m.reply_to) {
    const rm = Q.msgById.get(m.reply_to);
    if (rm) { const ra = rm.user_id ? Q.userById.get(rm.user_id) : null;
      reply = { id: rm.id, body: rm.deleted ? '' : rm.body, display: ra ? ra.display : '—', deleted: !!rm.deleted }; }
  }
  return {
    id: m.id, roomId: m.room_id, kind: m.kind, body: m.deleted ? '' : m.body,
    deleted: !!m.deleted, edited: !!m.edited, createdAt: m.created_at, replyTo: reply,
    author: miniUser(author), reactions: reactionSummary(m.id, meId),
  };
}

// ───────────────────────── Express ─────────────────────────
const app = express();
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"],
    styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:'],
    connectSrc: ["'self'", 'ws:', 'wss:'], mediaSrc: ["'self'", 'blob:'],
  } },
}));
app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50, standardHeaders: true, legacyHeaders: false });

function auth(req, res, next) {
  const t = req.cookies?.token;
  if (!t) return res.status(401).json({ error: 'غير مسجّل الدخول' });
  try { const p = jwt.verify(t, JWT_SECRET); const u = Q.userById.get(p.id);
    if (!u || u.banned) return res.status(401).json({ error: 'الجلسة غير صالحة' });
    req.user = u; next();
  } catch { res.status(401).json({ error: 'الجلسة منتهية' }); }
}

app.post('/api/register', authLimiter, async (req, res) => {
  let { username, display, password, country } = req.body || {};
  username = clamp(username, 20).trim().toLowerCase();
  display = clamp(display || username, 24).trim();
  password = String(password || '');
  country = COUNTRIES.includes(country) ? country : 'SA';
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'اسم المستخدم: 3-20 (إنجليزي صغير/أرقام/_)' });
  if (password.length < 6) return res.status(400).json({ error: 'كلمة المرور 6 أحرف على الأقل' });
  if (!display) display = username;
  if (Q.userByName.get(username)) return res.status(409).json({ error: 'اسم المستخدم محجوز' });
  const pass_hash = await bcrypt.hash(password, 11);
  const first = Q.countUsers.get().c === 0;
  const colors = ['#7c6cff', '#ff6cab', '#5ad1c5', '#ffb86c', '#78d2ff', '#b48cff'];
  const info = Q.createUser.run({ username, display, pass_hash, avatar: '🌙',
    color: colors[Math.floor(Math.random() * colors.length)], country, role: first ? 'owner' : 'member', created_at: now() });
  const u = Q.userById.get(info.lastInsertRowid);
  res.cookie('token', signToken(u), { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 30 * 864e5 });
  res.json({ user: userPublic(u) });
});

app.post('/api/login', authLimiter, async (req, res) => {
  let { username, password } = req.body || {};
  username = clamp(username, 20).trim().toLowerCase();
  const u = Q.userByName.get(username);
  if (!u) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  if (u.banned) return res.status(403).json({ error: 'هذا الحساب محظور' });
  if (!await bcrypt.compare(String(password || ''), u.pass_hash)) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  res.cookie('token', signToken(u), { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 30 * 864e5 });
  res.json({ user: userPublic(u) });
});

app.post('/api/logout', (req, res) => { res.clearCookie('token'); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => res.json({ user: userPublic(req.user), inbox: Q.dmInbox.all(req.user.id) }));

app.put('/api/me', auth, (req, res) => {
  let { display, avatar, color, bio, vibe, country, social } = req.body || {};
  display = clamp(display || req.user.display, 24).trim() || req.user.username;
  avatar = clamp(avatar || '🌙', 8);
  color = /^#[0-9a-fA-F]{6}$/.test(color) ? color : req.user.color;
  bio = clamp(bio, 160); vibe = clamp(vibe, 40);
  country = COUNTRIES.includes(country) ? country : req.user.country;
  const soc = {};
  for (const k of ['twitter', 'instagram', 'snapchat', 'tiktok', 'youtube']) {
    const v = clamp(social?.[k], 60).trim(); if (v) soc[k] = v;
  }
  Q.updateProfile.run(display, avatar, color, bio, vibe, country, JSON.stringify(soc), req.user.id);
  res.json({ user: userPublic(Q.userById.get(req.user.id)) });
});

// بروفايل مستخدم عام
app.get('/api/users/:id', auth, (req, res) => {
  const u = Q.userById.get(+req.params.id);
  if (!u) return res.status(404).json({ error: 'غير موجود' });
  const pub = userPublic(u);
  pub.likedByMe = !!Q.liked.get(req.user.id, u.id);
  res.json({ user: pub });
});

app.get('/api/rooms', auth, (req, res) => {
  const rooms = Q.rooms.all().map(r => ({
    id: r.id, slug: r.slug, name: r.name, topic: r.topic, icon: r.icon, kind: r.kind,
    capacity: r.capacity, seats: r.seats,
    online: io.sockets.adapter.rooms.get('room:' + r.id)?.size || 0,
  }));
  res.json({ rooms });
});

app.post('/api/rooms', auth, (req, res) => {
  let { name, topic, icon, kind, capacity, seats, welcome } = req.body || {};
  name = clamp(name, 40).trim();
  if (name.length < 2) return res.status(400).json({ error: 'اسم الغرفة قصير' });
  topic = clamp(topic, 120); icon = clamp(icon || '💬', 8);
  kind = kind === 'text' ? 'text' : 'voice';
  capacity = Math.min(200, Math.max(2, +capacity || 40));
  seats = kind === 'text' ? 0 : Math.min(20, Math.max(2, +seats || 8));
  welcome = clamp(welcome, 160);
  const base = (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'room');
  let slug = base, i = 1; while (Q.roomBySlug.get(slug)) slug = base + '-' + (++i);
  const info = Q.createRoom.run(slug, name, topic, icon, kind, capacity, seats, welcome, req.user.id, now());
  const r = Q.roomById.get(info.lastInsertRowid);
  const payload = { id: r.id, slug: r.slug, name: r.name, topic: r.topic, icon: r.icon, kind: r.kind, capacity: r.capacity, seats: r.seats, online: 0 };
  io.emit('room:new', payload);
  res.json({ room: payload });
});

app.get('/api/rooms/:id/messages', auth, (req, res) => {
  const roomId = +req.params.id;
  const before = +req.query.before || Number.MAX_SAFE_INTEGER;
  const q = (req.query.q || '').toString().trim();
  if (q) return res.json({ messages: Q.searchMsgs.all(roomId, '%' + q.replace(/[%_]/g, '') + '%').reverse().map(m => hydrateMsg(m, req.user.id)) });
  res.json({ messages: Q.recentMsgs.all(roomId, before, 30).reverse().map(m => hydrateMsg(m, req.user.id)) });
});

// ── الخاص ──
app.get('/api/dm/:id', auth, (req, res) => {
  const other = +req.params.id;
  Q.dmSeen.run(req.user.id, other);
  const rows = Q.dmThread.all(req.user.id, other, other, req.user.id).reverse();
  res.json({ messages: rows.map(m => ({ id: m.id, from: m.from_id, to: m.to_id, body: m.body, createdAt: m.created_at, mine: m.from_id === req.user.id })) });
});

// ── الحائط ──
function hydrateWall(p, meId) {
  const u = p.user_id ? Q.userById.get(p.user_id) : null;
  return { id: p.id, body: p.body, createdAt: p.created_at, author: miniUser(u),
    likes: Q.wallLikeCount.get(p.id).c, likedByMe: !!Q.wallLikedByMe.get(p.id, meId) };
}
app.get('/api/wall', auth, (req, res) => res.json({ posts: Q.wallList.all().map(p => hydrateWall(p, req.user.id)) }));
app.post('/api/wall', auth, (req, res) => {
  const body = clamp(req.body?.body, 500).trim();
  if (!body) return res.status(400).json({ error: 'منشور فارغ' });
  const info = Q.wallInsert.run(req.user.id, body, now());
  const post = hydrateWall(Q.wallById.get(info.lastInsertRowid), req.user.id);
  io.emit('wall:new', post);
  res.json({ post });
});
app.post('/api/wall/:id/like', auth, (req, res) => {
  const id = +req.params.id;
  if (Q.wallLikedByMe.get(id, req.user.id)) Q.wallUnlike.run(id, req.user.id);
  else Q.wallLike.run(id, req.user.id);
  const likes = Q.wallLikeCount.get(id).c;
  io.emit('wall:like', { id, likes });
  res.json({ likes, likedByMe: !!Q.wallLikedByMe.get(id, req.user.id) });
});
app.delete('/api/wall/:id', auth, (req, res) => {
  const p = Q.wallById.get(+req.params.id);
  if (!p) return res.status(404).json({ error: 'غير موجود' });
  if (p.user_id !== req.user.id && req.user.role !== 'owner' && req.user.role !== 'admin') return res.status(403).json({ error: 'لا تملك صلاحية' });
  Q.wallDelete.run(p.id); io.emit('wall:del', { id: p.id }); res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));

// ───────────────────────── Socket.io ─────────────────────────
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });

io.use((socket, next) => {
  try {
    const token = cookie.parse(socket.handshake.headers.cookie || '').token;
    const p = jwt.verify(token, JWT_SECRET); const u = Q.userById.get(p.id);
    if (!u || u.banned) return next(new Error('unauthorized'));
    socket.user = u; next();
  } catch { next(new Error('unauthorized')); }
});

// حالة الصوت في الذاكرة: roomId -> Array(seat) حيث كل مقعد = {userId,...}|null
const voiceRooms = new Map();
function voiceState(roomId) {
  if (!voiceRooms.has(roomId)) {
    const r = Q.roomById.get(roomId);
    voiceRooms.set(roomId, { seats: new Array(r?.seats || 0).fill(null) });
  }
  return voiceRooms.get(roomId);
}
function seatsPayload(roomId) { return voiceState(roomId).seats; }
function leaveSeat(roomId, userId) {
  const vs = voiceRooms.get(roomId); if (!vs) return false;
  let changed = false;
  vs.seats = vs.seats.map(s => (s && s.userId === userId ? (changed = true, null) : s));
  return changed;
}

// مكافحة سبام
const rateMap = new Map();
function spammy(userId) {
  const t = now(); const arr = (rateMap.get(userId) || []).filter(x => t - x < 10000);
  arr.push(t); rateMap.set(userId, arr); return arr.length > 8;
}

function presenceOf(roomId) {
  const set = io.sockets.adapter.rooms.get('room:' + roomId);
  const seen = new Map();
  if (set) for (const sid of set) { const s = io.sockets.sockets.get(sid);
    if (s?.user) seen.set(s.user.id, { ...s.user, socketId: sid }); }
  return [...seen.values()].map(u => ({
    id: u.id, display: u.display, avatar: u.avatar, color: u.color, role: u.role,
    level: u.level, vibe: u.vibe, country: u.country, likes: u.likes, socketId: u.socketId,
  }));
}
function emitPresence(roomId) { io.to('room:' + roomId).emit('presence', { roomId, users: presenceOf(roomId) }); }
function emitSeats(roomId) { io.to('room:' + roomId).emit('voice:seats', { roomId, seats: seatsPayload(roomId) }); }

io.on('connection', (socket) => {
  const me = socket.user;
  socket.data.roomId = null;

  // أرسل id السوكِت للعميل
  socket.emit('ready', { socketId: socket.id, userId: me.id });

  socket.on('room:join', (roomId, cb) => {
    roomId = +roomId; const room = Q.roomById.get(roomId);
    if (!room) return cb?.({ error: 'الغرفة غير موجودة' });
    const cur = io.sockets.adapter.rooms.get('room:' + roomId)?.size || 0;
    if (socket.data.roomId !== roomId && cur >= room.capacity) return cb?.({ error: 'الغرفة ممتلئة' });
    if (socket.data.roomId) { const prev = socket.data.roomId; socket.leave('room:' + prev);
      leaveSeat(prev, me.id); socket.data.roomId = null; emitPresence(prev); emitSeats(prev);
      io.to('room:' + prev).emit('voice:peerleft', { socketId: socket.id }); }
    socket.join('room:' + roomId); socket.data.roomId = roomId;
    const rows = Q.recentMsgs.all(roomId, Number.MAX_SAFE_INTEGER, 30).reverse();
    cb?.({ room: { id: room.id, name: room.name, topic: room.topic, icon: room.icon, kind: room.kind, seats: room.seats, capacity: room.capacity, welcome: room.welcome },
           messages: rows.map(m => hydrateMsg(m, me.id)), voiceSeats: seatsPayload(roomId) });
    emitPresence(roomId); emitSeats(roomId);
    io.to('room:' + roomId).emit('system', { roomId, text: `دخل ${me.display} ${room.icon}` });
  });

  socket.on('msg:send', (payload, cb) => {
    const roomId = socket.data.roomId; if (!roomId) return cb?.({ error: 'لم تنضم لغرفة' });
    const fresh = Q.userById.get(me.id);
    if (fresh.banned) return cb?.({ error: 'محظور' });
    if (fresh.muted_until > now()) return cb?.({ error: 'أنت مكتوم حتى ' + new Date(fresh.muted_until).toLocaleTimeString('ar') });
    let body = clamp(payload?.body, 2000).trim(); if (!body) return cb?.({ error: 'رسالة فارغة' });
    if (spammy(me.id)) return cb?.({ error: 'تمهّل — رسائل كثيرة بسرعة' });
    let kind = 'msg';
    if (body.startsWith('/me ')) { kind = 'me'; body = body.slice(4).trim(); }
    else if (body === '/shrug') body += ' ¯\\_(ツ)_/¯';
    const replyTo = payload?.replyTo ? +payload.replyTo : null;
    const info = Q.insMsg.run(roomId, me.id, body, replyTo, kind, now());
    const gain = 5 + Math.min(10, Math.floor(body.length / 20));
    const newXp = fresh.xp + gain, newLevel = levelFromXp(newXp);
    Q.addXp.run(gain, newLevel, me.id);
    if (newLevel > fresh.level) { io.to('room:' + roomId).emit('system', { roomId, text: `🎉 ${me.display} وصل للمستوى ${newLevel}!` });
      for (const s of io.sockets.sockets.values()) if (s.user?.id === me.id) s.user.level = newLevel; }
    io.to('room:' + roomId).emit('msg:new', hydrateMsg(Q.msgById.get(info.lastInsertRowid), null));
    const mentions = [...new Set((body.match(/@([a-z0-9_]{3,20})/gi) || []).map(x => x.slice(1).toLowerCase()))];
    for (const uname of mentions) for (const s of io.sockets.sockets.values())
      if (s.user?.username === uname && s.id !== socket.id) s.emit('mention', { from: me.display, roomId, preview: clamp(body, 80) });
    cb?.({ ok: true, xp: gain });
  });

  socket.on('typing', (t) => { const r = socket.data.roomId; if (r) socket.to('room:' + r).emit('typing', { roomId: r, user: me.display, isTyping: !!t }); });

  socket.on('msg:edit', ({ id, body }, cb) => {
    const m = Q.msgById.get(+id); if (!m || m.deleted) return cb?.({ error: 'غير موجود' });
    if (m.user_id !== me.id) return cb?.({ error: 'ليست رسالتك' });
    const nb = clamp(body, 2000).trim(); if (!nb) return cb?.({ error: 'فارغة' });
    Q.editMsg.run(nb, m.id); io.to('room:' + m.room_id).emit('msg:update', hydrateMsg(Q.msgById.get(m.id), null)); cb?.({ ok: true });
  });
  socket.on('msg:delete', ({ id }, cb) => {
    const m = Q.msgById.get(+id); if (!m) return cb?.({ error: 'غير موجود' });
    const fresh = Q.userById.get(me.id); const isMod = fresh.role === 'owner' || fresh.role === 'admin';
    if (m.user_id !== me.id && !isMod) return cb?.({ error: 'لا تملك صلاحية' });
    Q.delMsg.run(m.id); io.to('room:' + m.room_id).emit('msg:update', hydrateMsg(Q.msgById.get(m.id), null)); cb?.({ ok: true });
  });
  socket.on('react', ({ id, emoji }, cb) => {
    if (!EMOJI_SET.includes(emoji)) return cb?.({ error: 'غير مسموح' });
    const m = Q.msgById.get(+id); if (!m || m.deleted) return cb?.({ error: 'غير موجود' });
    const had = Q.myReactions.all(m.id, me.id).some(r => r.emoji === emoji);
    if (had) Q.delReaction.run(m.id, me.id, emoji); else Q.addReaction.run(m.id, me.id, emoji);
    io.to('room:' + m.room_id).emit('react:update', { id: m.id, reactions: Q.reactionsFor.all(m.id).map(r => ({ emoji: r.emoji, count: r.c })) }); cb?.({ ok: true });
  });

  // ── الإعجاب بالأعضاء ──
  socket.on('user:like', ({ userId }, cb) => {
    userId = +userId; if (userId === me.id) return cb?.({ error: 'لا يمكنك إعجاب نفسك' });
    const target = Q.userById.get(userId); if (!target) return cb?.({ error: 'غير موجود' });
    const had = Q.liked.get(me.id, userId);
    if (had) { Q.delLike.run(me.id, userId); Q.incLikes.run(-1, userId); }
    else { Q.addLike.run(me.id, userId, now()); Q.incLikes.run(1, userId);
      for (const s of io.sockets.sockets.values()) if (s.user?.id === userId) s.emit('notify', { type: 'like', text: `❤️ أعجب ${me.display} بك` }); }
    const likes = Q.userById.get(userId).likes;
    for (const s of io.sockets.sockets.values()) if (s.user?.id === userId) s.user.likes = likes;
    const r = socket.data.roomId; if (r) emitPresence(r);
    cb?.({ ok: true, likes, likedByMe: !had });
  });

  // ── الخاص ──
  socket.on('dm:send', ({ toId, body }, cb) => {
    toId = +toId; body = clamp(body, 2000).trim(); if (!body) return cb?.({ error: 'فارغة' });
    const target = Q.userById.get(toId); if (!target) return cb?.({ error: 'غير موجود' });
    const info = Q.insDM.run(me.id, toId, body, now());
    const msg = { id: info.lastInsertRowid, from: me.id, to: toId, body, createdAt: now() };
    for (const s of io.sockets.sockets.values()) if (s.user?.id === toId)
      s.emit('dm:new', { ...msg, mine: false, author: miniUser(Q.userById.get(me.id)) });
    cb?.({ ok: true, msg: { ...msg, mine: true } });
  });

  // ── الإشراف ──
  function requireMod() { const f = Q.userById.get(me.id); return (f.role === 'owner' || f.role === 'admin') ? f : null; }
  socket.on('mod:mute', ({ userId, minutes }, cb) => {
    if (!requireMod()) return cb?.({ error: 'لا تملك صلاحية' });
    const target = Q.userById.get(+userId); if (!target) return cb?.({ error: 'غير موجود' });
    if (target.role === 'owner') return cb?.({ error: 'لا يمكن كتم المالك' });
    Q.setMute.run(now() + Math.min(1440, Math.max(1, +minutes || 5)) * 60000, target.id);
    const r = socket.data.roomId; if (r) io.to('room:' + r).emit('system', { roomId: r, text: `🔇 كتم ${target.display}` }); cb?.({ ok: true });
  });
  socket.on('mod:ban', ({ userId }, cb) => {
    if (!requireMod()) return cb?.({ error: 'لا تملك صلاحية' });
    const target = Q.userById.get(+userId); if (!target) return cb?.({ error: 'غير موجود' });
    if (target.role === 'owner') return cb?.({ error: 'لا يمكن حظر المالك' });
    Q.setBan.run(1, target.id);
    for (const s of io.sockets.sockets.values()) if (s.user?.id === target.id) { s.emit('banned'); s.disconnect(true); }
    const r = socket.data.roomId; if (r) io.to('room:' + r).emit('system', { roomId: r, text: `⛔ حظر ${target.display}` }); cb?.({ ok: true });
  });
  socket.on('mod:role', ({ userId, role }, cb) => {
    if (Q.userById.get(me.id).role !== 'owner') return cb?.({ error: 'للمالك فقط' });
    if (!['admin', 'member'].includes(role)) return cb?.({ error: 'رتبة غير صالحة' });
    Q.setRole.run(role, +userId);
    for (const s of io.sockets.sockets.values()) if (s.user?.id === +userId) s.user.role = role;
    const r = socket.data.roomId; if (r) emitPresence(r); cb?.({ ok: true });
  });
  socket.on('mod:kickmic', ({ userId }, cb) => {
    if (!requireMod()) return cb?.({ error: 'لا تملك صلاحية' });
    const r = socket.data.roomId; if (!r) return;
    if (leaveSeat(r, +userId)) { emitSeats(r);
      for (const s of io.sockets.sockets.values()) if (s.user?.id === +userId && s.data.roomId === r) io.to('room:' + r).emit('voice:peerleft', { socketId: s.id }); }
    cb?.({ ok: true });
  });

  // ── الصوت: المقاعد ──
  socket.on('mic:take', ({ seatIndex } = {}, cb) => {
    const roomId = socket.data.roomId; if (!roomId) return cb?.({ error: 'انضم لغرفة أولاً' });
    const vs = voiceState(roomId);
    if (!vs.seats.length) return cb?.({ error: 'هذه غرفة كتابية' });
    if (vs.seats.some(s => s && s.userId === me.id)) return cb?.({ error: 'أنت على المايك' });
    const fresh = Q.userById.get(me.id);
    if (fresh.muted_until > now()) return cb?.({ error: 'أنت مكتوم' });
    let idx = (Number.isInteger(seatIndex) && seatIndex >= 0 && seatIndex < vs.seats.length && !vs.seats[seatIndex]) ? seatIndex : vs.seats.findIndex(s => !s);
    if (idx < 0) return cb?.({ error: 'كل المقاعد ممتلئة' });
    vs.seats[idx] = { userId: me.id, socketId: socket.id, display: me.display, avatar: me.avatar, color: me.color, role: me.role, muted: false, speaking: false };
    emitSeats(roomId); cb?.({ ok: true, seatIndex: idx });
  });
  socket.on('mic:leave', (_, cb) => {
    const roomId = socket.data.roomId; if (!roomId) return;
    if (leaveSeat(roomId, me.id)) { emitSeats(roomId); io.to('room:' + roomId).emit('voice:peerleft', { socketId: socket.id }); } cb?.({ ok: true });
  });
  socket.on('mic:mute', ({ muted }, cb) => {
    const roomId = socket.data.roomId; const vs = voiceRooms.get(roomId); if (!vs) return;
    const seat = vs.seats.find(s => s && s.userId === me.id); if (seat) { seat.muted = !!muted; emitSeats(roomId); } cb?.({ ok: true });
  });
  socket.on('mic:speaking', ({ speaking }) => {
    const roomId = socket.data.roomId; const vs = voiceRooms.get(roomId); if (!vs) return;
    const seat = vs.seats.find(s => s && s.userId === me.id);
    if (seat && seat.speaking !== !!speaking) { seat.speaking = !!speaking;
      io.to('room:' + roomId).emit('voice:speaking', { userId: me.id, speaking: !!speaking }); }
  });

  // ── WebRTC relay (توجيه حسب socketId) ──
  socket.on('voice:offer', ({ to, sdp }) => io.to(to).emit('voice:offer', { from: socket.id, sdp }));
  socket.on('voice:answer', ({ to, sdp }) => io.to(to).emit('voice:answer', { from: socket.id, sdp }));
  socket.on('voice:ice', ({ to, cand, role }) => io.to(to).emit('voice:ice', { from: socket.id, cand, role }));

  socket.on('disconnecting', () => {
    const r = socket.data.roomId;
    if (r) { leaveSeat(r, me.id);
      setTimeout(() => { emitPresence(r); emitSeats(r); }, 50);
      socket.to('room:' + r).emit('voice:peerleft', { socketId: socket.id }); }
  });
});

server.listen(PORT, () => console.log(`🌙 Layl Chat v2 يعمل على http://localhost:${PORT}`));
