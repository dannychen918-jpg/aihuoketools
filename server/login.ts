import type { Page } from 'playwright'
import { getContextForAccount, saveAccountSession } from './browser.js'
import db from './db.js'

interface LoginSession {
  accountId: string
  page: Page
  status: 'opening' | 'waiting_user' | 'success' | 'failed'
  error?: string
  startedAt: number
}

const sessions = new Map<string, LoginSession>()

// Authentication cookie names per platform.
// Detecting login by cookie is far more reliable than DOM-based heuristics.
const platformConfigs: Record<string, {
  loginUrl: string
  authCookieNames: string[]
  cookieDomains: string[]
}> = {
  douyin: {
    loginUrl: 'https://www.douyin.com/',
    authCookieNames: ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard', 'uid_tt', 'LOGIN_STATUS', 'passport_auth_status'],
    cookieDomains: ['.douyin.com', 'www.douyin.com'],
  },
  kuaishou: {
    loginUrl: 'https://www.kuaishou.com/',
    authCookieNames: ['kuaishou.web.cp.api_st', 'kuaishou.web.api_st', 'userId', 'passToken'],
    cookieDomains: ['.kuaishou.com', 'www.kuaishou.com'],
  },
  xiaohongshu: {
    loginUrl: 'https://www.xiaohongshu.com/explore',
    authCookieNames: ['web_session', 'webId', 'a1', 'unread'],
    cookieDomains: ['.xiaohongshu.com', 'www.xiaohongshu.com'],
  },
}

async function detectLoginByCookies(
  ctx: import('playwright').BrowserContext,
  config: typeof platformConfigs[string]
): Promise<boolean> {
  const cookies = await ctx.cookies().catch(() => [])
  // Match any of the auth cookie names on the correct domain with a non-empty value
  return cookies.some(c =>
    config.authCookieNames.includes(c.name) &&
    config.cookieDomains.some(d => c.domain === d || c.domain.endsWith(d)) &&
    !!c.value &&
    c.value.length > 5
  )
}

export async function startLogin(accountId: string, platform: string): Promise<{ status: string }> {
  const config = platformConfigs[platform]
  if (!config) throw new Error(`不支持的平台: ${platform}`)

  const existing = sessions.get(accountId)
  if (existing) {
    try { await existing.page.close() } catch {}
    sessions.delete(accountId)
  }

  const ctx = await getContextForAccount(accountId)
  const page = await ctx.newPage()

  const session: LoginSession = {
    accountId,
    page,
    status: 'opening',
    startedAt: Date.now(),
  }
  sessions.set(accountId, session)

  ;(async () => {
    try {
      await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
      session.status = 'waiting_user'

      const timeout = 300000 // 5 minutes
      const startTime = Date.now()
      const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

      while (Date.now() - startTime < timeout) {
        await sleep(2000)

        // Detect login via cookies — works whether window is open or just closed
        try {
          if (await detectLoginByCookies(ctx, config)) {
            await saveAccountSession(accountId, ctx)
            db.prepare('UPDATE accounts SET status = ? WHERE id = ?').run('online', accountId)
            session.status = 'success'
            await sleep(800)
            if (!page.isClosed()) {
              try { await page.close() } catch {}
            }
            return
          }
        } catch {}

        if (page.isClosed()) {
          session.status = 'failed'
          session.error = '窗口已关闭，未检测到登录'
          return
        }
      }
      session.status = 'failed'
      session.error = '登录超时'
    } catch (err) {
      session.status = 'failed'
      session.error = err instanceof Error ? err.message : String(err)
    }
  })()

  return { status: 'opening' }
}

export function getLoginStatus(accountId: string) {
  const session = sessions.get(accountId)
  if (!session) return { status: 'not_started' }
  return { status: session.status, error: session.error }
}

export async function cancelLogin(accountId: string) {
  const session = sessions.get(accountId)
  if (session) {
    try { await session.page.close() } catch {}
    sessions.delete(accountId)
  }
}
