// server.js — Layl Chat : خادم HTTP + WebSocket لحظي
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
// في الإنتاج: ضع JWT_SECRET في متغيّر بيئة
const JWT_SECRET = process.env.JWT_SECRET || 'layl-dev-secret-change-me-in-production';
const PROD = process.env.NODE_ENV === 'production';

// ───────────────────────── أدوات مساعدة ─────────────────────────
const now = () => Date.now();
const clamp = (s, n) => String(s ?? '').slice(0, n);

// نظام الخبرة والمستويات (التدرّج يصعب تدريجياً)
const levelFromXp = (xp) => Math.max(1, Math.floor(0.25 * Math.sqrt(xp)) + 1);
const xpForLevel = (lv) => Math.pow((lv - 1) / 0.25, 2);

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const EMOJI_SET = ['❤️', '🔥', '😂', '👍', '😮', '😢', '🙏', '🌙'];

function signToken(user) {
  return jwt.sign({ id: user.id, u: user.username }, JWT_SECRET, { expiresIn: '30d' });
}
function userPublic(u) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, display: u.display, avatar: u.avatar,
    color: u.color, bio: u.bio, vibe: u.vibe, role: u.role,
    xp: u.xp, level: u.level,
    nextLevelXp: Math.ceil(xpForLevel(u.level + 1)),
    thisLevelXp: Math.ceil(xpForLevel(u.level)),
  };
}

// استعلامات جاهزة
const Q = {
  userByName: db.prepare('SELECT * FROM users WHERE username=?'),
  userById: db.prepare('SELECT * FROM users WHERE id=?'),
  createUser: db.prepare(`INSERT INTO users(username,display,pass_hash,avatar,color,role,created_at)
                          VALUES(@username,@display,@pass_hash,@avatar,@color,@role,@created_at)`),
  countUsers: db.prepare('SELECT COUNT(*) c FROM users'),
  updateProfile: db.prepare('UPDATE users SET display=?, avatar=?, color=?, bio=?, vibe=? WHERE id=?'),
  addXp: db.prepare('UPDATE users SET xp=xp+?, level=? WHERE id=?'),
  setRole: db.prepare('UPDATE users SET role=? WHERE id=?'),
  setBan: db.prepare('UPDATE users SET banned=? WHERE id=?'),
  setMute: db.prepare('UPDATE users SET muted_until=? WHERE id=?'),

  rooms: db.prepare('SELECT * FROM rooms ORDER BY id'),
  roomBySlug: db.prepare('SELECT * FROM rooms WHERE slug=?'),
  roomById: db.prepare('SELECT * FROM rooms WHERE id=?'),
  createRoom: db.prepare(`INSERT INTO rooms(slug,name,topic,icon,owner_id,created_at)
                          VALUES(?,?,?,?,?,?)`),

  insMsg: db.prepare(`INSERT INTO messages(room_id,user_id,body,reply_to,kind,created_at)
                      VALUES(?,?,?,?,?,?)`),
  msgById: db.prepare('SELECT * FROM messages WHERE id=?'),
  editMsg: db.prepare('UPDATE messages SET body=?, edited=1 WHERE id=?'),
  delMsg: db.prepare("UPDATE messages SET deleted=1, body='' WHERE id=?"),
  recentMsgs: db.prepare(`SELECT * FROM messages WHERE room_id=? AND id < ? ORDER BY id DESC LIMIT ?`),
  searchMsgs: db.prepare(`SELECT * FROM messages WHERE room_id=? AND deleted=0 AND body LIKE ?
                          ORDER BY id DESC LIMIT 40`),

  addReaction: db.prepare('INSERT OR IGNORE INTO reactions(message_id,user_id,emoji) VALUES(?,?,?)'),
  delReaction: db.prepare('DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?'),
  reactionsFor: db.prepare('SELECT emoji, COUNT(*) c FROM reactions WHERE message_id=? GROUP BY emoji'),
  myReactions: db.prepare('SELECT emoji FROM reactions WHERE message_id=? AND user_id=?'),
};

function reactionSummary(msgId, meId) {
  const counts = Q.reactionsFor.all(msgId);
  const mine = new Set(Q.myReactions.all(msgId, meId || 0).map(r => r.emoji));
  return counts.map(r => ({ emoji: r.emoji, count: r.c, mine: mine.has(r.emoji) }));
}

// تحويل رسالة من القاعدة إلى شكل العرض
function hydrateMsg(m, meId) {
  const author = m.user_id ? Q.userById.get(m.user_id) : null;
  let reply = null;
  if (m.reply_to) {
    const rm = Q.msgById.get(m.reply_to);
    if (rm) {
      const ra = rm.user_id ? Q.userById.get(rm.user_id) : null;
      reply = { id: rm.id, body: rm.deleted ? '' : rm.body, display: ra ? ra.display : '—', deleted: !!rm.deleted };
    }
  }
  return {
    id: m.id, roomId: m.room_id, kind: m.kind,
    body: m.deleted ? '' : m.body, deleted: !!m.deleted, edited: !!m.edited,
    createdAt: m.created_at, replyTo: reply,
    author: author ? { id: author.id, display: author.display, avatar: author.avatar, color: author.color, role: author.role, level: author.level } : null,
    reactions: reactionSummary(m.id, meId),
  };
}

// ───────────────────────── Express ─────────────────────────
const app = express();
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
    },
  },
}));
app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false });

// ميدل وير المصادقة
function auth(req, res, next) {
  const t = req.cookies?.token;
  if (!t) return res.status(401).json({ error: 'غير مسجّل الدخول' });
  try {
    const p = jwt.verify(t, JWT_SECRET);
    const u = Q.userById.get(p.id);
    if (!u || u.banned) return res.status(401).json({ error: 'الجلسة غير صالحة' });
    req.user = u;
    next();
  } catch {
    res.status(401).json({ error: 'الجلسة منتهية' });
  }
}

// ── تسجيل حساب ──
app.post('/api/register', authLimiter, async (req, res) => {
  let { username, display, password } = req.body || {};
  username = clamp(username, 20).trim().toLowerCase();
  display = clamp(display || username, 24).trim();
  password = String(password || '');
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'اسم المستخدم: 3-20 حرف إنجليزي صغير/أرقام/شرطة سفلية' });
  if (password.length < 6) return res.status(400).json({ error: 'كلمة المرور 6 أحرف على الأقل' });
  if (!display) display = username;
  if (Q.userByName.get(username)) return res.status(409).json({ error: 'اسم المستخدم محجوز' });

  const pass_hash = await bcrypt.hash(password, 11);
  const first = Q.countUsers.get().c === 0;
  const colors = ['#7c6cff', '#ff6cab', '#5ad1c5', '#ffb86c', '#78d2ff', '#b48cff'];
  const info = Q.createUser.run({
    username, display, pass_hash,
    avatar: '🌙', color: colors[Math.floor(Math.random() * colors.length)],
    role: first ? 'owner' : 'member', created_at: now(),
  });
  const u = Q.userById.get(info.lastInsertRowid);
  res.cookie('token', signToken(u), { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 30 * 864e5 });
  res.json({ user: userPublic(u) });
});

// ── تسجيل دخول ──
app.post('/api/login', authLimiter, async (req, res) => {
  let { username, password } = req.body || {};
  username = clamp(username, 20).trim().toLowerCase();
  const u = Q.userByName.get(username);
  if (!u) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  if (u.banned) return res.status(403).json({ error: 'هذا الحساب محظور' });
  const ok = await bcrypt.compare(String(password || ''), u.pass_hash);
  if (!ok) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  res.cookie('token', signToken(u), { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 30 * 864e5 });
  res.json({ user: userPublic(u) });
});

app.post('/api/logout', (req, res) => { res.clearCookie('token'); res.json({ ok: true }); });

app.get('/api/me', auth, (req, res) => res.json({ user: userPublic(req.user) }));

app.put('/api/me', auth, (req, res) => {
  let { display, avatar, color, bio, vibe } = req.body || {};
  display = clamp(display || req.user.display, 24).trim() || req.user.username;
  avatar = clamp(avatar || '🌙', 8);
  color = /^#[0-9a-fA-F]{6}$/.test(color) ? color : req.user.color;
  bio = clamp(bio, 160);
  vibe = clamp(vibe, 40);
  Q.updateProfile.run(display, avatar, color, bio, vibe, req.user.id);
  res.json({ user: userPublic(Q.userById.get(req.user.id)) });
});

app.get('/api/rooms', auth, (req, res) => {
  const rooms = Q.rooms.all().map(r => ({
    id: r.id, slug: r.slug, name: r.name, topic: r.topic, icon: r.icon,
    online: io.sockets.adapter.rooms.get('room:' + r.id)?.size || 0,
  }));
  res.json({ rooms });
});

app.post('/api/rooms', auth, (req, res) => {
  let { name, topic, icon } = req.body || {};
  name = clamp(name, 40).trim();
  if (name.length < 2) return res.status(400).json({ error: 'اسم الغرفة قصير' });
  topic = clamp(topic, 120);
  icon = clamp(icon || '💬', 8);
  const base = (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'room');
  let slug = base, i = 1;
  while (Q.roomBySlug.get(slug)) slug = base + '-' + (++i);
  const info = Q.createRoom.run(slug, name, topic, icon, req.user.id, now());
  const r = Q.roomById.get(info.lastInsertRowid);
  io.emit('room:new', { id: r.id, slug: r.slug, name: r.name, topic: r.topic, icon: r.icon, online: 0 });
  res.json({ room: { id: r.id, slug: r.slug, name: r.name, topic: r.topic, icon: r.icon } });
});

// رسائل سابقة (تمرير للأعلى) + بحث
app.get('/api/rooms/:id/messages', auth, (req, res) => {
  const roomId = +req.params.id;
  const before = +req.query.before || Number.MAX_SAFE_INTEGER;
  const q = (req.query.q || '').toString().trim();
  if (q) {
    const rows = Q.searchMsgs.all(roomId, '%' + q.replace(/[%_]/g, '') + '%');
    return res.json({ messages: rows.reverse().map(m => hydrateMsg(m, req.user.id)) });
  }
  const rows = Q.recentMsgs.all(roomId, before, 30);
  res.json({ messages: rows.reverse().map(m => hydrateMsg(m, req.user.id)) });
});

app.use(express.static(path.join(__dirname, 'public')));

// ───────────────────────── Socket.io ─────────────────────────
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });

// مصادقة السوكِت عبر الكوكي
io.use((socket, next) => {
  try {
    const raw = socket.handshake.headers.cookie || '';
    const token = cookie.parse(raw).token;
    const p = jwt.verify(token, JWT_SECRET);
    const u = Q.userById.get(p.id);
    if (!u || u.banned) return next(new Error('unauthorized'));
    socket.user = u;
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

// مكافحة السبام: نافذة منزلقة
const rateMap = new Map(); // userId -> [timestamps]
function spammy(userId) {
  const t = now();
  const arr = (rateMap.get(userId) || []).filter(x => t - x < 10000);
  arr.push(t);
  rateMap.set(userId, arr);
  return arr.length > 8; // أكثر من 8 رسائل خلال 10 ثوانٍ
}

function presenceOf(roomId) {
  const set = io.sockets.adapter.rooms.get('room:' + roomId);
  const seen = new Map();
  if (set) for (const sid of set) {
    const s = io.sockets.sockets.get(sid);
    if (s?.user) seen.set(s.user.id, s.user);
  }
  return [...seen.values()].map(u => ({
    id: u.id, display: u.display, avatar: u.avatar, color: u.color,
    role: u.role, level: u.level, vibe: u.vibe,
  }));
}
function emitPresence(roomId) {
  io.to('room:' + roomId).emit('presence', { roomId, users: presenceOf(roomId) });
}

io.on('connection', (socket) => {
  const me = socket.user;
  socket.data.roomId = null;

  socket.on('room:join', (roomId, cb) => {
    roomId = +roomId;
    const room = Q.roomById.get(roomId);
    if (!room) return cb?.({ error: 'الغرفة غير موجودة' });
    if (socket.data.roomId) { socket.leave('room:' + socket.data.roomId); const prev = socket.data.roomId; socket.data.roomId = null; emitPresence(prev); }
    socket.join('room:' + roomId);
    socket.data.roomId = roomId;
    const rows = Q.recentMsgs.all(roomId, Number.MAX_SAFE_INTEGER, 30).reverse();
    cb?.({ room: { id: room.id, name: room.name, topic: room.topic, icon: room.icon },
           messages: rows.map(m => hydrateMsg(m, me.id)) });
    emitPresence(roomId);
    io.to('room:' + roomId).emit('system', { roomId, text: `انضمّ ${me.display} إلى الغرفة` });
  });

  socket.on('msg:send', (payload, cb) => {
    const roomId = socket.data.roomId;
    if (!roomId) return cb?.({ error: 'لم تنضم لغرفة' });
    const fresh = Q.userById.get(me.id);
    if (fresh.banned) return cb?.({ error: 'محظور' });
    if (fresh.muted_until > now())
      return cb?.({ error: 'أنت مكتوم حتى ' + new Date(fresh.muted_until).toLocaleTimeString('ar') });
    let body = clamp(payload?.body, 2000).trim();
    if (!body) return cb?.({ error: 'رسالة فارغة' });
    if (spammy(me.id)) return cb?.({ error: 'تمهّل — رسائل كثيرة بسرعة' });

    let kind = 'msg';
    // أوامر مائلة
    if (body.startsWith('/me ')) { kind = 'me'; body = body.slice(4).trim(); }
    else if (body === '/shrug') { body = body + ' ¯\\_(ツ)_/¯'; }

    const replyTo = payload?.replyTo ? +payload.replyTo : null;
    const info = Q.insMsg.run(roomId, me.id, body, replyTo, kind, now());

    // خبرة + ترقية مستوى
    const gain = 5 + Math.min(10, Math.floor(body.length / 20));
    const newXp = fresh.xp + gain;
    const newLevel = levelFromXp(newXp);
    Q.addXp.run(gain, newLevel, me.id);
    if (newLevel > fresh.level) {
      io.to('room:' + roomId).emit('system', { roomId, text: `🎉 ${me.display} وصل للمستوى ${newLevel}!` });
      // حدّث نسخة السوكِت
      for (const s of io.sockets.sockets.values()) if (s.user?.id === me.id) s.user.level = newLevel;
    }

    const msg = hydrateMsg(Q.msgById.get(info.lastInsertRowid), null);
    io.to('room:' + roomId).emit('msg:new', msg);

    // إشعار المنشَنات @user
    const mentions = [...new Set((body.match(/@([a-z0-9_]{3,20})/gi) || []).map(x => x.slice(1).toLowerCase()))];
    for (const uname of mentions) {
      for (const s of io.sockets.sockets.values())
        if (s.user?.username === uname && s.id !== socket.id)
          s.emit('mention', { from: me.display, roomId, preview: clamp(body, 80) });
    }
    cb?.({ ok: true, xp: gain });
  });

  socket.on('typing', (isTyping) => {
    const roomId = socket.data.roomId; if (!roomId) return;
    socket.to('room:' + roomId).emit('typing', { roomId, user: me.display, isTyping: !!isTyping });
  });

  socket.on('msg:edit', ({ id, body }, cb) => {
    const m = Q.msgById.get(+id);
    if (!m || m.deleted) return cb?.({ error: 'غير موجود' });
    if (m.user_id !== me.id) return cb?.({ error: 'ليست رسالتك' });
    const nb = clamp(body, 2000).trim(); if (!nb) return cb?.({ error: 'فارغة' });
    Q.editMsg.run(nb, m.id);
    io.to('room:' + m.room_id).emit('msg:update', hydrateMsg(Q.msgById.get(m.id), null));
    cb?.({ ok: true });
  });

  socket.on('msg:delete', ({ id }, cb) => {
    const m = Q.msgById.get(+id);
    if (!m) return cb?.({ error: 'غير موجود' });
    const fresh = Q.userById.get(me.id);
    const isMod = fresh.role === 'owner' || fresh.role === 'admin';
    if (m.user_id !== me.id && !isMod) return cb?.({ error: 'لا تملك صلاحية' });
    Q.delMsg.run(m.id);
    io.to('room:' + m.room_id).emit('msg:update', hydrateMsg(Q.msgById.get(m.id), null));
    cb?.({ ok: true });
  });

  socket.on('react', ({ id, emoji }, cb) => {
    if (!EMOJI_SET.includes(emoji)) return cb?.({ error: 'إيموجي غير مسموح' });
    const m = Q.msgById.get(+id); if (!m || m.deleted) return cb?.({ error: 'غير موجود' });
    const had = Q.myReactions.all(m.id, me.id).some(r => r.emoji === emoji);
    if (had) Q.delReaction.run(m.id, me.id, emoji);
    else Q.addReaction.run(m.id, me.id, emoji);
    // أرسل ملخّصاً عاماً + دع كل عميل يحسب "mine" محلياً
    io.to('room:' + m.room_id).emit('react:update', { id: m.id, reactions: Q.reactionsFor.all(m.id).map(r => ({ emoji: r.emoji, count: r.c })) });
    cb?.({ ok: true });
  });

  // ── إشراف: كتم / حظر / رتبة ──
  function requireMod() { const f = Q.userById.get(me.id); return (f.role === 'owner' || f.role === 'admin') ? f : null; }

  socket.on('mod:mute', ({ userId, minutes }, cb) => {
    if (!requireMod()) return cb?.({ error: 'لا تملك صلاحية' });
    const target = Q.userById.get(+userId); if (!target) return cb?.({ error: 'غير موجود' });
    if (target.role === 'owner') return cb?.({ error: 'لا يمكن كتم المالك' });
    const until = now() + Math.min(1440, Math.max(1, +minutes || 5)) * 60000;
    Q.setMute.run(until, target.id);
    const rid = socket.data.roomId;
    if (rid) io.to('room:' + rid).emit('system', { roomId: rid, text: `🔇 تم كتم ${target.display}` });
    cb?.({ ok: true });
  });

  socket.on('mod:ban', ({ userId }, cb) => {
    const f = requireMod(); if (!f) return cb?.({ error: 'لا تملك صلاحية' });
    const target = Q.userById.get(+userId); if (!target) return cb?.({ error: 'غير موجود' });
    if (target.role === 'owner') return cb?.({ error: 'لا يمكن حظر المالك' });
    Q.setBan.run(1, target.id);
    for (const s of io.sockets.sockets.values())
      if (s.user?.id === target.id) { s.emit('banned'); s.disconnect(true); }
    const rid = socket.data.roomId;
    if (rid) io.to('room:' + rid).emit('system', { roomId: rid, text: `⛔ تم حظر ${target.display}` });
    cb?.({ ok: true });
  });

  socket.on('mod:role', ({ userId, role }, cb) => {
    const f = Q.userById.get(me.id);
    if (f.role !== 'owner') return cb?.({ error: 'للمالك فقط' });
    if (!['admin', 'member'].includes(role)) return cb?.({ error: 'رتبة غير صالحة' });
    Q.setRole.run(role, +userId);
    for (const s of io.sockets.sockets.values()) if (s.user?.id === +userId) s.user.role = role;
    cb?.({ ok: true });
  });

  socket.on('disconnecting', () => {
    const rid = socket.data.roomId;
    if (rid) setTimeout(() => emitPresence(rid), 50);
  });
});

server.listen(PORT, () => console.log(`🌙 Layl Chat يعمل على http://localhost:${PORT}`));
