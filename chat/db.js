// db.js — طبقة قاعدة البيانات (SQLite) لمنصة Layl Chat v2
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, 'layl.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT UNIQUE NOT NULL,
  display     TEXT NOT NULL,
  pass_hash   TEXT NOT NULL,
  avatar      TEXT DEFAULT '🌙',
  color       TEXT DEFAULT '#7c6cff',          -- لون الاسم
  bio         TEXT DEFAULT '',
  vibe        TEXT DEFAULT '',                  -- الحالة
  country     TEXT DEFAULT 'SA',               -- رمز الدولة ISO
  social      TEXT DEFAULT '{}',               -- روابط سوشيال JSON
  role        TEXT DEFAULT 'member',           -- owner | admin | member
  xp          INTEGER DEFAULT 0,
  level       INTEGER DEFAULT 1,
  likes       INTEGER DEFAULT 0,               -- عدد الإعجابات المستلمة
  banned      INTEGER DEFAULT 0,
  muted_until INTEGER DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  topic      TEXT DEFAULT '',
  icon       TEXT DEFAULT '💬',
  kind       TEXT DEFAULT 'voice',             -- voice | text
  capacity   INTEGER DEFAULT 40,
  seats      INTEGER DEFAULT 8,                -- عدد مقاعد المايك
  welcome    TEXT DEFAULT '',                  -- رسالة ترحيب
  owner_id   INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id    INTEGER NOT NULL,
  user_id    INTEGER,
  body       TEXT NOT NULL,
  reply_to   INTEGER,
  edited     INTEGER DEFAULT 0,
  deleted    INTEGER DEFAULT 0,
  kind       TEXT DEFAULT 'msg',               -- msg | system | me
  created_at INTEGER NOT NULL,
  FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_room ON messages(room_id, id);

CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  emoji      TEXT NOT NULL,
  PRIMARY KEY(message_id, user_id, emoji),
  FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- رسائل خاصة
CREATE TABLE IF NOT EXISTS dms (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id    INTEGER NOT NULL,
  to_id      INTEGER NOT NULL,
  body       TEXT NOT NULL,
  seen       INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(from_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(to_id)   REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_dm_pair ON dms(from_id, to_id, id);

-- إعجابات الأعضاء (من أعجب بمن)
CREATE TABLE IF NOT EXISTS user_likes (
  liker_id  INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(liker_id, target_id),
  FOREIGN KEY(liker_id)  REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(target_id) REFERENCES users(id) ON DELETE CASCADE
);

-- الحائط (منشورات عامة)
CREATE TABLE IF NOT EXISTS wall_posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS wall_likes (
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  PRIMARY KEY(post_id, user_id),
  FOREIGN KEY(post_id) REFERENCES wall_posts(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
`);

// ── الستوري / الحالات (تختفي بعد 24 ساعة) ──
db.exec(`
CREATE TABLE IF NOT EXISTS stories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  body       TEXT DEFAULT '',
  bg         TEXT DEFAULT 'g1',               -- مفتاح التدرّج اللوني
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_story_exp ON stories(expires_at);
CREATE TABLE IF NOT EXISTS story_views (
  story_id   INTEGER NOT NULL,
  viewer_id  INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(story_id, viewer_id),
  FOREIGN KEY(story_id)  REFERENCES stories(id) ON DELETE CASCADE,
  FOREIGN KEY(viewer_id) REFERENCES users(id) ON DELETE CASCADE
);
`);

// ترحيل بسيط: أضف الأعمدة الناقصة لقواعد البيانات القديمة
function ensureColumn(table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}
ensureColumn('users', 'story_notify', 'INTEGER DEFAULT 1'); // إشعار من شاهد حالتي

// غرف افتراضية عند أول تشغيل
const roomCount = db.prepare('SELECT COUNT(*) c FROM rooms').get().c;
if (roomCount === 0) {
  const t = Date.now();
  const ins = db.prepare(
    'INSERT INTO rooms(slug,name,topic,icon,kind,capacity,seats,welcome,created_at) VALUES(?,?,?,?,?,?,?,?,?)'
  );
  ins.run('general', 'الغرفة العامة', 'دردشة صوتية وكتابية للجميع', '🌙', 'voice', 40, 10, 'حيّاكم الله في ليل 🌙 — نوّرتوا!', t);
  ins.run('vibes', 'ليل فايبز', 'موسيقى وأجواء الليل', '✨', 'voice', 40, 12, 'أهلاً في ليل فايبز ✨', t);
  ins.run('poetry', 'أمسية شعر', 'شعر وإلقاء على المايك', '🎙️', 'voice', 30, 8, 'منبر الشعراء مفتوح 🎙️', t);
  ins.run('gaming', 'الألعاب', 'سواليف وتنسيق ألعاب', '🎮', 'voice', 40, 10, 'جمعة اللعيبة هنا 🎮', t);
  ins.run('lounge', 'الاستراحة', 'نقاشات هادئة (كتابي)', '☕', 'text', 60, 0, 'استرِح وخذ راحتك ☕', t);
}

export default db;
