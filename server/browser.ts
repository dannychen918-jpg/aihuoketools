import { chromium, type BrowserContext, type Page } from 'playwright'
import path from 'path'
import fs from 'fs'
import db from './db.js'

// Use persistent context per account so each account gets a stable browser fingerprint
// and cookies/localStorage persist naturally across sessions.
const PROFILE_ROOT = path.join(process.cwd(), '.browser-profiles')
if (!fs.existsSync(PROFILE_ROOT)) fs.mkdirSync(PROFILE_ROOT, { recursive: true })

const contexts = new Map<string, BrowserContext>()

const STEALTH_INIT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
  window.chrome = { runtime: {} };
  const originalQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (parameters) => (
    parameters.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : originalQuery(parameters)
  );
  // Block anti-bot triggered auto-reload. Override reload as a non-throwing noop.
  try {
    const origReload = Location.prototype.reload;
    Object.defineProperty(Location.prototype, 'reload', {
      configurable: true,
      writable: true,
      value: function() { console.log('[stealth] reload blocked'); }
    });
  } catch (e) {}
  // Block visibilitychange-triggered reloads
  Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
  Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
`

export async function getContextForAccount(accountId: string): Promise<BrowserContext> {
  const existing = contexts.get(accountId)
  if (existing) return existing

  const profileDir = path.join(PROFILE_ROOT, accountId)
  if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true })

  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: null, // use real window size
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-infobars',
      '--start-maximized',
      '--exclude-switches=enable-automation',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  })

  await ctx.addInitScript(STEALTH_INIT)

  // If we have cookies saved separately, restore them too (for back-compat)
  const session = db.prepare('SELECT cookies_json FROM account_sessions WHERE account_id = ?')
    .get(accountId) as { cookies_json: string } | undefined
  if (session?.cookies_json) {
    try {
      const cookies = JSON.parse(session.cookies_json)
      if (Array.isArray(cookies) && cookies.length > 0) {
        await ctx.addCookies(cookies)
      }
    } catch {}
  }

  contexts.set(accountId, ctx)

  ctx.on('close', () => {
    contexts.delete(accountId)
  })

  return ctx
}

export async function saveAccountSession(accountId: string, ctx: BrowserContext) {
  const cookies = await ctx.cookies()
  const cookiesJson = JSON.stringify(cookies)
  db.prepare(`
    INSERT INTO account_sessions (account_id, cookies_json, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(account_id) DO UPDATE SET cookies_json = excluded.cookies_json, updated_at = excluded.updated_at
  `).run(accountId, cookiesJson)
}

export async function closeContextForAccount(accountId: string) {
  const ctx = contexts.get(accountId)
  if (ctx) {
    await ctx.close().catch(() => {})
    contexts.delete(accountId)
  }
  // Also wipe the profile directory so the deleted account is fully gone
  const profileDir = path.join(PROFILE_ROOT, accountId)
  if (fs.existsSync(profileDir)) {
    fs.rmSync(profileDir, { recursive: true, force: true })
  }
}

export async function newPage(accountId: string): Promise<Page> {
  const ctx = await getContextForAccount(accountId)
  // launchPersistentContext opens a default about:blank page. Reuse it instead
  // of opening a second tab the user can't see.
  const pages = ctx.pages()
  const blank = pages.find(p => {
    const u = p.url()
    return u === 'about:blank' || u === '' || u === 'chrome://newtab/'
  })
  if (blank && !blank.isClosed()) return blank
  return ctx.newPage()
}
