import Database from 'better-sqlite3'
import path from 'path'

const DB_PATH = path.join(import.meta.dirname, '..', 'data.db')

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

// Migration: add url column to legacy videos table if missing
try {
  const cols = db.prepare("PRAGMA table_info(videos)").all() as Array<{ name: string }>
  if (cols.length > 0 && !cols.some(c => c.name === 'url')) {
    db.exec('ALTER TABLE videos ADD COLUMN url TEXT')
  }
  if (cols.length > 0 && !cols.some(c => c.name === 'published_count')) {
    db.exec('ALTER TABLE videos ADD COLUMN published_count INTEGER DEFAULT 0')
    // Backfill from any historical completed tasks so we don't "unpublish" old work
    try {
      db.exec(`
        UPDATE videos SET published_count = (
          SELECT COUNT(*) FROM publish_tasks t
          WHERE t.video_id = videos.id AND t.status = 'completed'
        )
      `)
    } catch {}
  }
  const accountCols = db.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>
  if (accountCols.length > 0 && !accountCols.some(c => c.name === 'today_reset_date')) {
    db.exec("ALTER TABLE accounts ADD COLUMN today_reset_date TEXT")
  }
} catch {}

// Reset accounts.today_published to 0 for any account whose last reset date
// isn't today (server local time). Call before every read/write that depends
// on today's counter — at server startup, on /api/accounts, and at the top of
// the publish worker tick.
export function resetTodayPublishedIfNeeded() {
  db.prepare(`
    UPDATE accounts
       SET today_published = 0,
           today_reset_date = date('now', 'localtime')
     WHERE today_reset_date IS NULL
        OR today_reset_date != date('now', 'localtime')
  `).run()
}

// Drop duplicate active tasks: for any video that has more than one
// pending/publishing task, keep only the oldest and delete the rest. Runs on
// startup so existing queues with the old "one task per account per video"
// behavior get cleaned up automatically.
export function dedupeActivePublishTasks(): number {
  const result = db.prepare(`
    DELETE FROM publish_tasks
     WHERE status IN ('pending', 'publishing')
       AND id NOT IN (
         SELECT MIN(id) FROM publish_tasks
          WHERE status IN ('pending', 'publishing')
          GROUP BY video_id
       )
  `).run()
  return result.changes
}

db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL CHECK(platform IN ('douyin', 'kuaishou', 'xiaohongshu')),
    title TEXT NOT NULL,
    likes INTEGER DEFAULT 0,
    comments INTEGER DEFAULT 0,
    shares INTEGER DEFAULT 0,
    published_at TEXT,
    keyword TEXT,
    url TEXT,
    published_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS generated_comments (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id),
    content TEXT NOT NULL,
    style TEXT NOT NULL CHECK(style IN ('resonance', 'curiosity', 'experience')),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    platform TEXT NOT NULL CHECK(platform IN ('douyin', 'kuaishou', 'xiaohongshu')),
    avatar TEXT NOT NULL,
    status TEXT DEFAULT 'online' CHECK(status IN ('online', 'expired')),
    daily_limit INTEGER DEFAULT 20,
    today_published INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS publish_tasks (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    video_id TEXT NOT NULL REFERENCES videos(id),
    comment_content TEXT NOT NULL,
    scheduled_time TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('publishing', 'pending', 'completed', 'error')),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS account_sessions (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id),
    cookies_json TEXT NOT NULL,
    storage_json TEXT,
    user_agent TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`)

function seed() {
  const videoCount = (db.prepare('SELECT COUNT(*) as c FROM videos').get() as { c: number }).c
  if (videoCount > 0) return

  const videos = [
    { id: 'v1', platform: 'douyin', title: '千川投流这个坑我踩了3个月，终于搞懂了...', likes: 24000, comments: 368, shares: 1200, published_at: '3小时前', keyword: '千川投流' },
    { id: 'v2', platform: 'douyin', title: '直播间数据差不一定是流量问题，90%的人忽略了这点', likes: 18000, comments: 241, shares: 890, published_at: '6小时前', keyword: '直播运营' },
    { id: 'v3', platform: 'kuaishou', title: '起号第一周数据复盘，在线人数从3到200的过程', likes: 9600, comments: 187, shares: 560, published_at: '昨天', keyword: '直播运营' },
    { id: 'v4', platform: 'xiaohongshu', title: '主播培训到底有没有用？我的真实经历分享', likes: 6200, comments: 134, shares: 320, published_at: '昨天', keyword: '主播培训' },
    { id: 'v5', platform: 'douyin', title: '投流ROI打不平？可能是这几个数据你没看懂', likes: 11000, comments: 298, shares: 740, published_at: '2天前', keyword: '千川投流' },
    { id: 'v6', platform: 'kuaishou', title: '新手做直播带货，第一个月能赚多少钱？真实数据', likes: 15000, comments: 432, shares: 980, published_at: '2天前', keyword: '直播带货' },
    { id: 'v7', platform: 'xiaohongshu', title: '直播间话术模板分享，转化率提升50%的秘密', likes: 8800, comments: 256, shares: 670, published_at: '3天前', keyword: '直播运营' },
    { id: 'v8', platform: 'douyin', title: '千川素材怎么做？3个月测试200条的经验总结', likes: 32000, comments: 512, shares: 1500, published_at: '3天前', keyword: '千川投流' },
  ]

  const insertVideo = db.prepare(`INSERT INTO videos (id, platform, title, likes, comments, shares, published_at, keyword) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const v of videos) {
    insertVideo.run(v.id, v.platform, v.title, v.likes, v.comments, v.shares, v.published_at, v.keyword)
  }

  const accounts = [
    { id: 'a1', name: '张老板直播运营', platform: 'douyin', avatar: '张', status: 'online', daily_limit: 20, today_published: 8 },
    { id: 'a2', name: '电商操盘手李哥', platform: 'douyin', avatar: '李', status: 'online', daily_limit: 20, today_published: 5 },
    { id: 'a3', name: '快手运营王姐', platform: 'kuaishou', avatar: '王', status: 'online', daily_limit: 20, today_published: 3 },
    { id: 'a4', name: '陈老师主播培训', platform: 'xiaohongshu', avatar: '陈', status: 'expired', daily_limit: 20, today_published: 0 },
  ]

  const insertAccount = db.prepare(`INSERT INTO accounts (id, name, platform, avatar, status, daily_limit, today_published) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  for (const a of accounts) {
    insertAccount.run(a.id, a.name, a.platform, a.avatar, a.status, a.daily_limit, a.today_published)
  }
}

seed()
resetTodayPublishedIfNeeded()
const dedupedCount = dedupeActivePublishTasks()
if (dedupedCount > 0) console.log(`[db] removed ${dedupedCount} duplicate active tasks on startup`)

export default db
