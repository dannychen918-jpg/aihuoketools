import dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.join(import.meta.dirname, '..', '.env') })

import express from 'express'
import cors from 'cors'
import db, { resetTodayPublishedIfNeeded } from './db.js'
import { generateAIComment } from './ai.js'
import { startLogin, getLoginStatus, cancelLogin } from './login.js'
import { crawlPlatform, saveVideosToDb } from './crawler.js'
import { setPublishEnabled, setPublishConfig, getPublishStatus } from './publisher.js'

const app = express()
app.use(cors())
app.use(express.json())

// ========== Videos ==========

app.get('/api/videos', (req, res) => {
  const { platforms, keyword, minLikes, sortBy, excludePublished } = req.query

  // published_count is now a persistent column on videos (incremented by the
  // publisher worker on success), so deleting tasks no longer "unpublishes" videos.
  let sql = `SELECT v.* FROM videos v WHERE 1=1`
  const params: unknown[] = []

  if (excludePublished === 'true' || excludePublished === '1') {
    sql += ` AND COALESCE(v.published_count, 0) = 0`
  }

  if (platforms) {
    const list = (platforms as string).split(',')
    sql += ` AND v.platform IN (${list.map(() => '?').join(',')})`
    params.push(...list)
  }

  if (keyword) {
    const parts = (keyword as string).split(/[\s,/／、]+/).map(p => p.trim()).filter(Boolean)
    if (parts.length > 0) {
      const conds = parts.map(() => 'v.title LIKE ?').join(' OR ')
      sql += ` AND (${conds})`
      for (const p of parts) {
        params.push(`%${p}%`)
      }
    }
  }

  if (minLikes) {
    sql += ` AND v.likes >= ?`
    params.push(Number(minLikes))
  }

  if (sortBy === 'likes') {
    sql += ' ORDER BY v.likes DESC'
  } else if (sortBy === 'comments') {
    sql += ' ORDER BY v.comments DESC'
  } else {
    sql += ' ORDER BY v.created_at DESC'
  }

  const videos = db.prepare(sql).all(...params)
  res.json(videos)
})

app.get('/api/videos/stats', (_req, res) => {
  const r = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN COALESCE(published_count, 0) > 0 THEN 1 ELSE 0 END) as commented,
      SUM(CASE WHEN COALESCE(published_count, 0) = 0 THEN 1 ELSE 0 END) as pending
    FROM videos
  `).get() as { total: number; commented: number; pending: number }
  res.json(r)
})

// Physically delete videos that have been commented to. Cascades to their
// generated_comments. Skips any video that still has pending publish_tasks
// queued so we don't yank a row out from under the worker.
app.post('/api/videos/purge-commented', (_req, res) => {
  const purgeable = db.prepare(`
    SELECT v.id FROM videos v
    WHERE COALESCE(v.published_count, 0) > 0
      AND NOT EXISTS (
        SELECT 1 FROM publish_tasks t
        WHERE t.video_id = v.id AND t.status IN ('pending', 'publishing')
      )
  `).all() as Array<{ id: string }>
  const ids = purgeable.map(r => r.id)
  if (ids.length === 0) {
    res.json({ deleted: 0 })
    return
  }
  const tx = db.transaction((vids: string[]) => {
    const delGen = db.prepare('DELETE FROM generated_comments WHERE video_id = ?')
    const delTasks = db.prepare("DELETE FROM publish_tasks WHERE video_id = ? AND status IN ('completed', 'error')")
    const delVideo = db.prepare('DELETE FROM videos WHERE id = ?')
    for (const id of vids) {
      delGen.run(id)
      delTasks.run(id)
      delVideo.run(id)
    }
  })
  tx(ids)
  res.json({ deleted: ids.length })
})

// ========== AI Comment Generation ==========

app.post('/api/comments/generate', async (req, res) => {
  try {
    const { videos, style, note } = req.body as {
      videos: { id: string; title: string; platform: string }[]
      style: string
      note?: string
    }

    const results = []
    for (const video of videos) {
      const content = await generateAIComment(video.title, video.platform, style, note)
      const id = `c-${video.id}-${Date.now()}`

      db.prepare(`INSERT INTO generated_comments (id, video_id, content, style) VALUES (?, ?, ?, ?)`)
        .run(id, video.id, content, style)

      results.push({ id, videoId: video.id, videoTitle: video.title, content, style })
    }

    res.json(results)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack : ''
    process.stderr.write(`AI generation error: ${msg}\n${stack}\n`)
    res.status(500).json({ error: '评论生成失败', detail: msg })
  }
})

app.post('/api/comments/regenerate', async (req, res) => {
  try {
    const { commentId, videoTitle, platform, style, note } = req.body
    const content = await generateAIComment(videoTitle, platform, style, note)

    db.prepare('UPDATE generated_comments SET content = ? WHERE id = ?').run(content, commentId)

    res.json({ id: commentId, content })
  } catch (err) {
    console.error('Regenerate error:', err)
    res.status(500).json({ error: '重新生成失败' })
  }
})

app.put('/api/comments/:id', (req, res) => {
  const { content } = req.body
  db.prepare('UPDATE generated_comments SET content = ? WHERE id = ?').run(content, req.params.id)
  res.json({ success: true })
})

// Get already-generated comments that haven't been queued for publishing yet
app.get('/api/comments', (req, res) => {
  const { videoIds } = req.query
  if (!videoIds) {
    res.json([])
    return
  }
  const ids = (videoIds as string).split(',').filter(Boolean)
  if (ids.length === 0) {
    res.json([])
    return
  }
  const placeholders = ids.map(() => '?').join(',')
  // Return latest comment per video that isn't already in publish queue
  const sql = `
    SELECT c.*, v.title as video_title FROM generated_comments c
    JOIN videos v ON c.video_id = v.id
    WHERE c.video_id IN (${placeholders})
      AND c.id NOT IN (
        SELECT id FROM generated_comments gc
        WHERE EXISTS (
          SELECT 1 FROM publish_tasks t
          WHERE t.video_id = gc.video_id AND t.comment_content = gc.content
        )
      )
    GROUP BY c.video_id
    HAVING c.created_at = MAX(c.created_at)
  `
  const rows = db.prepare(sql).all(...ids)
  res.json(rows)
})

// ========== Accounts ==========

app.get('/api/accounts', (_req, res) => {
  resetTodayPublishedIfNeeded()
  const accounts = db.prepare('SELECT * FROM accounts').all()
  res.json(accounts)
})

app.post('/api/accounts', (req, res) => {
  const { name, platform, avatar } = req.body
  const id = `a-${Date.now()}`
  db.prepare('INSERT INTO accounts (id, name, platform, avatar, status) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, platform, avatar, 'expired')
  res.json({ id, name, platform, avatar, status: 'expired', daily_limit: 20, today_published: 0 })
})

app.delete('/api/accounts/:id', async (req, res) => {
  const { id } = req.params
  try {
    const { closeContextForAccount } = await import('./browser.js')
    await closeContextForAccount(id).catch(() => {})
    await cancelLogin(id).catch(() => {})

    db.prepare('DELETE FROM account_sessions WHERE account_id = ?').run(id)
    db.prepare('DELETE FROM publish_tasks WHERE account_id = ?').run(id)
    const result = db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
    res.json({ success: true, deleted: result.changes })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: msg })
  }
})

// ========== Publish Tasks ==========

app.get('/api/tasks', (_req, res) => {
  const tasks = db.prepare(`
    SELECT t.*, v.title as video_title, a.name as account_name, a.avatar as account_avatar, a.platform as account_platform
    FROM publish_tasks t
    JOIN videos v ON t.video_id = v.id
    JOIN accounts a ON t.account_id = a.id
    ORDER BY t.created_at DESC
  `).all()
  res.json(tasks)
})

app.post('/api/tasks', (req, res) => {
  const { accountId, videoId, commentContent, scheduledTime } = req.body
  // Reject if this video already has an active or completed task on any account —
  // one comment per video is the rule.
  const existing = db.prepare(
    "SELECT id FROM publish_tasks WHERE video_id = ? AND status IN ('pending', 'publishing', 'completed') LIMIT 1"
  ).get(videoId) as { id: string } | undefined
  if (existing) {
    res.status(409).json({ error: 'duplicate', existingTaskId: existing.id })
    return
  }
  const id = `t-${Date.now()}-${Math.floor(Math.random() * 1000)}`
  db.prepare('INSERT INTO publish_tasks (id, account_id, video_id, comment_content, scheduled_time) VALUES (?, ?, ?, ?, ?)')
    .run(id, accountId, videoId, commentContent, scheduledTime || new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))
  res.json({ id, status: 'pending' })
})

app.patch('/api/tasks/:id', (req, res) => {
  const { status } = req.body
  db.prepare('UPDATE publish_tasks SET status = ? WHERE id = ?').run(status, req.params.id)
  res.json({ success: true })
})

app.delete('/api/tasks/:id', (req, res) => {
  const result = db.prepare('DELETE FROM publish_tasks WHERE id = ?').run(req.params.id)
  res.json({ deleted: result.changes })
})

app.delete('/api/tasks', (req, res) => {
  // Optional ?status=error or ?status=completed to clear specific status
  const { status } = req.query
  let result
  if (status) {
    result = db.prepare('DELETE FROM publish_tasks WHERE status = ?').run(status as string)
  } else {
    result = db.prepare('DELETE FROM publish_tasks').run()
  }
  res.json({ deleted: result.changes })
})

// ========== Publish Worker ==========

app.get('/api/publish/status', (_req, res) => {
  res.json(getPublishStatus())
})

app.post('/api/publish/start', (req, res) => {
  const { intervalMinSec, intervalMaxSec, dailyLimitPerAccount } = req.body || {}
  if (intervalMinSec || intervalMaxSec || dailyLimitPerAccount) {
    setPublishConfig({ intervalMinSec, intervalMaxSec, dailyLimitPerAccount })
  }
  setPublishEnabled(true)
  res.json({ enabled: true })
})

app.post('/api/publish/stop', (_req, res) => {
  setPublishEnabled(false)
  res.json({ enabled: false })
})

app.post('/api/videos/delete', (req, res) => {
  const { ids } = req.body as { ids?: string[] }
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: 'ids required' })
    return
  }
  const tx = db.transaction((vids: string[]) => {
    const delGen = db.prepare('DELETE FROM generated_comments WHERE video_id = ?')
    const delTasks = db.prepare('DELETE FROM publish_tasks WHERE video_id = ?')
    const delVideo = db.prepare('DELETE FROM videos WHERE id = ?')
    let n = 0
    for (const id of vids) {
      delGen.run(id)
      delTasks.run(id)
      const r = delVideo.run(id)
      n += r.changes
    }
    return n
  })
  const deleted = tx(ids)
  res.json({ deleted })
})

app.delete('/api/videos/clear', (_req, res) => {
  // Wipe crawled videos and any dependent rows
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM generated_comments WHERE video_id LIKE 'dy-%' OR video_id LIKE 'ks-%' OR video_id LIKE 'xhs-%'").run()
    db.prepare("DELETE FROM publish_tasks WHERE video_id LIKE 'dy-%' OR video_id LIKE 'ks-%' OR video_id LIKE 'xhs-%'").run()
    return db.prepare("DELETE FROM videos WHERE id LIKE 'dy-%' OR id LIKE 'ks-%' OR id LIKE 'xhs-%'").run()
  })
  const result = tx()
  res.json({ deleted: result.changes })
})

// ========== Stats ==========

app.get('/api/stats', (_req, res) => {
  const videoCount = (db.prepare('SELECT COUNT(*) as c FROM videos').get() as { c: number }).c
  const commentCount = (db.prepare('SELECT COUNT(*) as c FROM generated_comments').get() as { c: number }).c
  const taskCount = (db.prepare('SELECT COUNT(*) as c FROM publish_tasks').get() as { c: number }).c
  const completedCount = (db.prepare("SELECT COUNT(*) as c FROM publish_tasks WHERE status = 'completed'").get() as { c: number }).c
  res.json({ videoCount, commentCount, taskCount, completedCount })
})

// ========== Login (QR scan) ==========

app.post('/api/accounts/:id/login', async (req, res) => {
  try {
    const { id } = req.params
    const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as { platform: string } | undefined
    if (!acc) return res.status(404).json({ error: '账号不存在' })

    const result = await startLogin(id, acc.platform)
    res.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('Login start error:', msg)
    res.status(500).json({ error: msg })
  }
})

app.get('/api/accounts/:id/login/status', (req, res) => {
  res.json(getLoginStatus(req.params.id))
})

app.post('/api/accounts/:id/login/cancel', async (req, res) => {
  await cancelLogin(req.params.id)
  res.json({ success: true })
})

// ========== Crawl ==========

app.post('/api/crawl', async (req, res) => {
  try {
    const { keyword, platforms, sortBy } = req.body as { keyword: string; platforms: string[]; sortBy?: 'recent' | 'likes' | 'comments' }
    if (!keyword || !platforms?.length) return res.status(400).json({ error: '缺少参数' })

    const onlineAccounts = db.prepare('SELECT * FROM accounts WHERE status = ?').all('online') as Array<{ id: string; platform: string }>

    const allResults = []
    const warnings: string[] = []
    let needCaptcha = false
    let totalInserted = 0
    let totalUpdated = 0

    for (const platform of platforms) {
      const account = onlineAccounts.find(a => a.platform === platform)
      if (!account) {
        warnings.push(`${platform}: 无可用账号（请先在「账号管理」登录）`)
        continue
      }
      try {
        const timeoutMs = 180000
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('抓取超时（3分钟）')), timeoutMs)
        )
        const report = await Promise.race([
          crawlPlatform(account.id, platform, keyword, 80, sortBy),
          timeoutPromise,
        ])

        // Trust Douyin's search — we navigated to the dedicated /search/{keyword}
        // URL, so all results are search-targeted. The previous strict
        // "title-literal-contains-keyword" filter was dropping cards whose
        // titles got split into short DOM nodes during parsing.
        // We keep a very loose sanity filter: any keyword-fragment overlap OR
        // any non-empty title is accepted.
        const kwParts = keyword.split(/[\s,/／、]+/).map(p => p.trim()).filter(Boolean)
        const relevant = report.videos.filter(v => {
          if (!v.title) return false
          if (kwParts.length === 0) return true
          // Accept if title shares any 2-char chunk with any kw fragment
          for (const part of kwParts) {
            if (part.length < 2) continue
            for (let i = 0; i <= part.length - 2; i++) {
              if (v.title.includes(part.slice(i, i + 2))) return true
            }
          }
          // Otherwise keep too — Douyin search said it's relevant
          return true
        })

        console.log(`[crawl] ${platform}: ${report.videos.length} raw, ${relevant.length} kept`)
        if (relevant.length > 0) {
          const { inserted, updated } = saveVideosToDb(relevant, keyword)
          totalInserted += inserted
          totalUpdated += updated
          console.log(`[crawl] ${platform}: db inserted=${inserted}, updated=${updated}`)
          allResults.push(...relevant)
        }
        if (report.videos.length === 0) {
          warnings.push(`${platform}: 未抓到任何视频，可能页面结构变化或被风控`)
        }
        if (report.needCaptcha) needCaptcha = true
        if (report.message) warnings.push(`${platform}: ${report.message}`)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.error(`Crawl ${platform} failed:`, msg)
        warnings.push(`${platform}: ${msg}`)
      }
    }

    res.json({
      count: allResults.length,
      newCount: totalInserted,
      updatedCount: totalUpdated,
      videos: allResults,
      warnings,
      needCaptcha,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('Crawl error:', msg)
    res.status(500).json({ error: msg })
  }
})

// One-shot: mark videos as already-published if they have generated comments
// but no active (pending/publishing/error) tasks. Used to recover state after
// completed tasks were deleted before published_count tracking existed.
app.post('/api/admin/backfill-published', (_req, res) => {
  const preview = db.prepare(`
    SELECT v.id, v.title FROM videos v
    WHERE COALESCE(v.published_count, 0) = 0
      AND v.id IN (SELECT DISTINCT video_id FROM generated_comments)
      AND v.id NOT IN (
        SELECT video_id FROM publish_tasks
        WHERE status IN ('pending', 'publishing', 'error')
      )
  `).all() as Array<{ id: string; title: string }>

  const result = db.prepare(`
    UPDATE videos SET published_count = 1
    WHERE COALESCE(published_count, 0) = 0
      AND id IN (SELECT DISTINCT video_id FROM generated_comments)
      AND id NOT IN (
        SELECT video_id FROM publish_tasks
        WHERE status IN ('pending', 'publishing', 'error')
      )
  `).run()
  res.json({ updated: result.changes, sample: preview.slice(0, 10).map(v => v.title.slice(0, 30)) })
})

app.get('/api/test-ai', async (_req, res) => {
  const BASE_URL = process.env.AI_BASE_URL
  const API_KEY = process.env.AI_API_KEY
  res.json({
    baseUrl: BASE_URL,
    keyPrefix: API_KEY?.slice(0, 15),
    envKeys: Object.keys(process.env).filter(k => k.startsWith('AI_')),
  })
})

const PORT = Number(process.env.PORT) || 3003
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})
