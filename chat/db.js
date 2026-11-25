// db.js — طبقة قاعدة البيانات (SQLite) لمنصة Layl Chat
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, 'layl.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT UNIQUE NOT NULL,              -- اسم الدخول (lowercase)
  display    TEXT NOT NULL,                     -- الاسم الظاهر
  pass_hash  TEXT NOT NULL,
  avatar     TEXT DEFAULT '🌙',                 -- إيموجي الأفاتار
  color      TEXT DEFAULT '#7c6cff',            -- لون المستخدم
  bio        TEXT DEFAULT '',
  vibe       TEXT DEFAULT '',                   -- الحالة/المزاج
  role       TEXT DEFAULT 'member',             -- owner | admin | member
  xp         INTEGER DEFAULT 0,
  level      INTEGER DEFAULT 1,
  banned     INTEGER DEFAULT 0,
  muted_until INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  topic      TEXT DEFAULT '',
  icon       TEXT DEFAULT '💬',
  owner_id   INTEGER,
  is_private INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id    INTEGER NOT NULL,
  user_id    INTEGER,
  body       TEXT NOT NULL,
  reply_to   INTEGER,                           -- id رسالة مُقتبسة
  edited     INTEGER DEFAULT 0,
  deleted    INTEGER DEFAULT 0,
  kind       TEXT DEFAULT 'msg',                -- msg | system | me
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
`);

// غرف افتراضية عند أول تشغيل
const roomCount = db.prepare('SELECT COUNT(*) c FROM rooms').get().c;
if (roomCount === 0) {
  const now = Date.now();
  const ins = db.prepare(
    'INSERT INTO rooms(slug,name,topic,icon,created_at) VALUES(?,?,?,?,?)'
  );
  ins.run('general', 'الساحة العامة', 'دردشة عامة للجميع', '🌙', now);
  ins.run('vibes', 'ليل فايبز', 'أجواء، موسيقى، وسواليف الليل', '✨', now);
  ins.run('lounge', 'الاستراحة', 'نقاشات هادئة', '☕', now);
  ins.run('gaming', 'الألعاب', 'كل ما يخص الألعاب', '🎮', now);
}

export default db;
