import { newPage } from './browser.js'
import db from './db.js'
import type { Page } from 'playwright'

interface CrawlResult {
  id: string
  platform: string
  title: string
  likes: number
  comments: number
  shares: number
  published_at: string
  url?: string
}

type SortBy = 'all' | 'recent' | 'likes' | 'comments' | undefined

export interface CrawlReport {
  count: number
  videos: CrawlResult[]
  needCaptcha?: boolean
  message?: string
}

function parseNumber(s: string): number {
  if (!s) return 0
  s = s.replace(/[,\s]/g, '')
  const wMatch = s.match(/([\d.]+)w/i) || s.match(/([\d.]+)万/)
  if (wMatch) return Math.round(parseFloat(wMatch[1]) * 10000)
  const kMatch = s.match(/([\d.]+)k/i)
  if (kMatch) return Math.round(parseFloat(kMatch[1]) * 1000)
  const n = parseInt(s, 10)
  return isNaN(n) ? 0 : n
}

async function hasCaptcha(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      // Intermediate verification page
      if (/验证码中间页|verification/i.test(document.title)) return true

      const candidates = document.querySelectorAll(
        '[class*="captcha" i], [id*="captcha" i], [id*="verify" i]'
      )
      for (const el of candidates) {
        const rect = (el as HTMLElement).getBoundingClientRect()
        if (rect.width >= 200 && rect.height >= 150 && rect.top >= 0) {
          const style = window.getComputedStyle(el as HTMLElement)
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            return true
          }
        }
      }
      const bodyText = document.body?.innerText || ''
      if (/短信验证|请输入本人持有手机号/.test(bodyText) &&
          /请输入验证码|获取验证码/.test(bodyText)) {
        return true
      }
      return false
    })
  } catch {
    return false
  }
}

async function hasResults(page: Page): Promise<number> {
  try {
    page.setDefaultTimeout(5000)
    const result = await page.evaluate(() => document.querySelectorAll('li').length)
    console.log('[crawl] hasResults evaluate returned:', result)
    return result
  } catch (e) {
    console.log('[crawl] hasResults error:', e instanceof Error ? e.message : e)
    return 0
  }
}

async function dumpPageInfo(page: Page): Promise<void> {
  try {
    const info = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      liItems: document.querySelectorAll('li').length,
    }))
    console.log('[crawl] page info:', JSON.stringify(info))
  } catch (e) {
    console.log('[crawl] dumpPageInfo error:', e instanceof Error ? e.message : e)
  }
}

async function hasServiceError(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const txt = document.body?.innerText || ''
      return /服务出现异常|服务异常|网络异常|请刷新|访问受限/.test(txt) &&
        document.querySelectorAll('a[href*="/video/"]').length === 0
    })
  } catch {
    return false
  }
}

async function humanLikeDelay(min = 800, max = 2000) {
  const ms = Math.floor(Math.random() * (max - min)) + min
  await new Promise(r => setTimeout(r, ms))
}

async function waitForSearchResults(page: Page, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (page.isClosed()) return false
    try {
      const count = await page.evaluate(() => {
        // Count @username markers — each video card has one
        const text = document.body?.innerText || ''
        return (text.match(/@[一-鿿\w\-]+/g) || []).length
      })
      if (count >= 3) {
        console.log(`[crawl] search results loaded: ${count} @user markers`)
        return true
      }
    } catch {}
    await new Promise(r => setTimeout(r, 800))
  }
  return false
}

async function douyinHumanSearch(page: Page, keyword: string, sortBy: SortBy): Promise<void> {
  const log = (msg: string) => console.log(`[crawl] ${msg}`)

  const currentUrl = page.url()
  if (!currentUrl.startsWith('https://www.douyin.com')) {
    log('navigating to douyin home...')
    await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await humanLikeDelay(2000, 3500)
    await page.mouse.wheel(0, 400 + Math.random() * 400)
    await humanLikeDelay(800, 1500)
  }

  // Map our sortBy to Douyin search URL params
  // sort_type: 0=综合, 1=最多点赞, 2=最新发布
  // publish_time: 0=不限, 1=一天内, 7=一周内, 180=半年内
  const params = new URLSearchParams({ type: 'video' })
  if (sortBy === 'recent') {
    params.set('sort_type', '2')
    params.set('publish_time', '180')
  } else if (sortBy === 'likes') {
    params.set('sort_type', '1')
  }
  const searchUrl = `https://www.douyin.com/search/${encodeURIComponent(keyword)}?${params}`

  await page.goto(searchUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  })
  log(`navigated to: ${searchUrl}`)
  await humanLikeDelay(5000, 7000)
  log(`current url after search: ${page.url()}`)

  // Scroll a bit to trigger lazy loading
  for (let i = 0; i < 2; i++) {
    await page.mouse.wheel(0, 800)
    await humanLikeDelay(800, 1200)
  }
}

export async function crawlDouyin(accountId: string, keyword: string, limit = 20, sortBy: SortBy = undefined): Promise<CrawlReport> {
  const page = await newPage(accountId)
  const sortParams = new URLSearchParams({ type: 'video' })
  if (sortBy === 'recent') { sortParams.set('sort_type', '2'); sortParams.set('publish_time', '180') }
  else if (sortBy === 'likes') sortParams.set('sort_type', '1')
  const searchUrl = `https://www.douyin.com/search/${encodeURIComponent(keyword)}?${sortParams}`

  try {
    // Human-like flow: visit homepage first, then use the searchbar
    await douyinHumanSearch(page, keyword, sortBy)

    // Stop the page from auto-refreshing/reloading. Inject script to no-op
    // common reload paths used by anti-bot scripts.
    try {
      await page.evaluate(() => {
        const noop = () => {}
        try { (window.location as any).reload = noop } catch {}
        try { history.go = noop as any } catch {}
        try { history.replaceState = noop as any } catch {}
        // Intercept meta refresh tags
        document.querySelectorAll('meta[http-equiv="refresh" i]').forEach(m => m.remove())
        // Disable visibilitychange handlers that could trigger reload
        const origAdd = EventTarget.prototype.addEventListener
        EventTarget.prototype.addEventListener = function(type: string, ...args: any[]) {
          if (type === 'visibilitychange' || type === 'blur' || type === 'focus') return
          return origAdd.call(this, type, ...args)
        }
      })
    } catch {}

    // Single evaluate to get everything we need at once.
    // This minimizes the chance the page navigates between calls.
    let pageState: { liCount: number; hasCaptcha: boolean; url: string; title: string } = {
      liCount: 0, hasCaptcha: false, url: '', title: '',
    }
    try {
      pageState = await page.evaluate(() => {
        const captchaEls = document.querySelectorAll('[class*="captcha" i], [id*="captcha" i], [id*="verify" i]')
        let hasVisibleCaptcha = false
        for (const el of captchaEls) {
          const rect = (el as HTMLElement).getBoundingClientRect()
          const style = window.getComputedStyle(el as HTMLElement)
          if (rect.width >= 200 && rect.height >= 150 && style.display !== 'none' && style.visibility !== 'hidden') {
            hasVisibleCaptcha = true
            break
          }
        }
        const bodyText = document.body?.innerText || ''
        const hasSmsVerify = /短信验证|请输入本人持有手机号|获取验证码/.test(bodyText) &&
          /请输入验证码|手机号/.test(bodyText)
        // Detect Douyin's intermediate verification page
        const isVerifyPage = /验证码中间页|verification|captcha/i.test(document.title) ||
          /verify|captcha/i.test(location.href)
        return {
          liCount: document.querySelectorAll('li').length,
          hasCaptcha: hasVisibleCaptcha || hasSmsVerify || isVerifyPage,
          url: location.href,
          title: document.title,
        }
      })
    } catch (e) {
      console.log('[crawl] page state evaluate error:', e instanceof Error ? e.message : e)
    }

    console.log(`[crawl] page state:`, JSON.stringify(pageState))
    const initialResults = pageState.liCount

    // Only check for captcha when no results loaded
    if (initialResults < 3 && pageState.hasCaptcha) {
      console.log('[crawl] Captcha detected, waiting for user to solve...')
      const deadline = Date.now() + 120000
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000))
        if (page.isClosed()) {
          return { count: 0, videos: [], needCaptcha: true, message: '浏览器窗口被关闭，请重新抓取' }
        }
        if (!(await hasCaptcha(page))) {
          console.log('[crawl] Captcha solved, reloading page...')
          break
        }
      }
      // After captcha solved or never present, ensure we're on a results page
      if (initialResults < 3) {
        try {
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
        } catch {}
        await page.waitForTimeout(2500)
      }
    }

    // Check for Douyin's "service error" page (anti-bot block)
    if (await hasServiceError(page)) {
      return {
        count: 0,
        videos: [],
        needCaptcha: true,
        message: '抖音风控提示"服务异常"。请在浏览器窗口中手动浏览几个视频后再次抓取，或换一个新账号重试',
      }
    }

    // Wait for at least a few search result links to appear
    const hasResults = await waitForSearchResults(page)
    if (!hasResults) {
      if (await hasServiceError(page)) {
        return {
          count: 0,
          videos: [],
          needCaptcha: true,
          message: '抖音风控提示"服务异常"。请在浏览器窗口中手动浏览几个视频后再次抓取',
        }
      }
      return { count: 0, videos: [], message: '未找到搜索结果，可能需要重试或更换关键词' }
    }

    // Douyin search uses virtual scrolling — only ~15 cards exist in DOM at
    // any time, recycled as you scroll. So we must extract-while-scrolling,
    // accumulating unique items by URL across many small scroll steps.
    type CrawlItem = { title: string; likes: string; url: string; publishedAt: string }
    type CrawlDebug = { liCount: number; cardRootCount: number; strategy: string; errors: string[]; sampleCardText: string }
    const accumulated = new Map<string, CrawlItem>()
    let lastDebug: CrawlDebug = { liCount: 0, cardRootCount: 0, strategy: '', errors: [], sampleCardText: '' }
    let consecutiveNoNew = 0
    const maxScrolls = 25  // plenty of room; we'll early-exit when nothing new
    for (let scrollIter = 0; scrollIter < maxScrolls; scrollIter++) {
      if (page.isClosed()) break
      const before = accumulated.size

      const batch = await page.evaluate((searchKeyword: string) => {
      const out: Array<{ title: string; likes: string; url: string; publishedAt: string }> = []
      const debugInfo: {
        liCount: number
        cardRootCount: number
        strategy: string
        errors: string[]
        sampleCardText: string
      } = { liCount: 0, cardRootCount: 0, strategy: '', errors: [], sampleCardText: '' }

      try {

      // Card detection — try multiple strategies in order:
      // 1. <li> elements that contain an <img> (Douyin search results are typically <li>)
      // 2. Walk up from @username text nodes
      // 3. Find divs containing both img + sufficient text
      const cardRoots = new Set<HTMLElement>()

      // Strategy 1: <li> with <img>
      const allLi = Array.from(document.querySelectorAll<HTMLElement>('li'))
      debugInfo.liCount = allLi.length
      for (const li of allLi) {
        if (li.querySelector('img') && (li.textContent?.length || 0) > 20) {
          cardRoots.add(li)
        }
      }
      if (cardRoots.size > 0) debugInfo.strategy = 'li'

      // Strategy 2 (fallback): walk up from @username
      if (cardRoots.size < 5) {
        // Match @username more leniently — element's text starts with @ and
        // is short, OR element contains exactly @xxx as one of its text nodes
        const allElems = Array.from(document.querySelectorAll<HTMLElement>('span, div, p, a'))
        const usernameElems = allElems.filter(el => {
          const t = (el.textContent || '').trim()
          if (t.length < 2 || t.length > 60) return false
          if (!t.startsWith('@')) return false
          // No nested cards: child element count low
          if (el.querySelectorAll('*').length > 3) return false
          return true
        })
        for (const u of usernameElems) {
          let cur: HTMLElement | null = u
          for (let i = 0; i < 12 && cur?.parentElement; i++) {
            cur = cur.parentElement
            const hasImg = !!cur.querySelector('img')
            const txtLen = cur.textContent?.length || 0
            const childCount = cur.querySelectorAll('*').length
            if (hasImg && txtLen > 20 && txtLen < 2000 && childCount < 400) {
              cardRoots.add(cur)
              break
            }
          }
        }
        if (cardRoots.size > 0 && !debugInfo.strategy) debugInfo.strategy = '@user-walkup'
      }

      // Strategy 3: any div with img + decent text
      if (cardRoots.size < 5) {
        const divsWithImg = Array.from(document.querySelectorAll<HTMLElement>('div:has(img)'))
        for (const d of divsWithImg) {
          const txtLen = d.textContent?.length || 0
          const childCount = d.querySelectorAll('*').length
          if (txtLen > 30 && txtLen < 1500 && childCount > 3 && childCount < 200) {
            // Avoid adding parents of existing roots
            let isContainedByExisting = false
            for (const existing of cardRoots) {
              if (existing.contains(d) || d.contains(existing)) {
                isContainedByExisting = true
                break
              }
            }
            if (!isContainedByExisting) cardRoots.add(d)
          }
        }
        if (cardRoots.size > 0 && !debugInfo.strategy) debugInfo.strategy = 'div-with-img'
      }
      debugInfo.cardRootCount = cardRoots.size
      if (cardRoots.size > 0) {
        const first = cardRoots.values().next().value as HTMLElement
        debugInfo.sampleCardText = (first?.textContent || '').slice(0, 150).replace(/\s+/g, ' ')
      }

      cardRoots.forEach(card => {
        // Collect text from each leaf element to get well-separated text pieces
        const leafTexts: string[] = []
        const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT)
        let node: Node | null
        while ((node = walker.nextNode())) {
          const t = node.textContent?.trim() || ''
          if (t) leafTexts.push(t)
        }

        // Title selection: prefer leaves containing the keyword; else longest.
        // Inlined predicate (no arrow function) — tsx adds __name() for arrow
        // function debug names which the browser doesn't have.
        let title = ''
        // Pass 1: prefer leaves containing the keyword
        if (searchKeyword) {
          for (const t of leafTexts) {
            if (t.length < 4 || t.length >= 300) continue
            if (t.startsWith('@') || t.startsWith('·')) continue
            if (/^\d{1,2}:\d{2}$/.test(t)) continue
            if (/^\d+(\.\d+)?[万kKw]?$/.test(t)) continue
            if (/^[\d\s,]+$/.test(t)) continue
            if (/^\d+月\d+日$/.test(t)) continue
            if (/^\d+\s*(分钟|小时|天|周|月|年)前$/.test(t)) continue
            if (t.includes(searchKeyword) && t.length > title.length) title = t
          }
        }
        // Pass 2: fall back to longest qualifying leaf
        if (!title) {
          for (const t of leafTexts) {
            if (t.length < 4 || t.length >= 300) continue
            if (t.startsWith('@') || t.startsWith('·')) continue
            if (/^\d{1,2}:\d{2}$/.test(t)) continue
            if (/^\d+(\.\d+)?[万kKw]?$/.test(t)) continue
            if (/^[\d\s,]+$/.test(t)) continue
            if (/^\d+月\d+日$/.test(t)) continue
            if (/^\d+\s*(分钟|小时|天|周|月|年)前$/.test(t)) continue
            if (t.length > title.length) title = t
          }
        }

        // Likes: collect all numeric-looking text and use the largest one as likes
        // (likes is usually the biggest number in the card, ahead of duration etc.)
        let likes = '0'
        let maxLikesValue = 0
        for (const t of leafTexts) {
          if (/^[\d.]+[万kKw]?$/.test(t)) {
            const val = /[万w]$/i.test(t) ? parseFloat(t) * 10000 :
                        /[kK]$/.test(t) ? parseFloat(t) * 1000 :
                        parseFloat(t)
            if (val > maxLikesValue) {
              maxLikesValue = val
              likes = t
            }
          }
        }

        // Robust URL extraction — Douyin may render cards WITHOUT <a> tags,
        // using onclick handlers and JS navigation instead. Try multiple sources.
        let rawUrl = ''
        // (a) descendant anchor with /video/
        const videoLink = card.querySelector('a[href*="/video/"]') as HTMLAnchorElement | null
        if (videoLink) rawUrl = videoLink.getAttribute('href') || ''
        // (b) ancestor anchor
        if (!rawUrl) {
          const ancestor = card.closest('a[href*="/video/"]') as HTMLAnchorElement | null
          if (ancestor) rawUrl = ancestor.getAttribute('href') || ''
        }
        // (c) any descendant anchor
        if (!rawUrl) {
          const anyAnchor = card.querySelector('a') as HTMLAnchorElement | null
          rawUrl = anyAnchor?.getAttribute('href') || ''
        }
        // (d) data attributes — Douyin often puts the aweme/video id on a data-* attr
        if (!rawUrl) {
          const allDataAttrs = ['data-id', 'data-video-id', 'data-aweme-id', 'data-e2e-id']
          for (const attr of allDataAttrs) {
            const el = card.querySelector(`[${attr}]`) as HTMLElement | null
            const v = el?.getAttribute(attr) || ''
            if (/^\d{15,}$/.test(v)) {
              rawUrl = `/video/${v}`
              break
            }
          }
        }
        // (e) scan all element attributes for a long-number id
        if (!rawUrl) {
          const candidates = card.querySelectorAll<HTMLElement>('*')
          outer: for (const el of candidates) {
            for (const attr of el.getAttributeNames()) {
              const v = el.getAttribute(attr) || ''
              const m = v.match(/(\d{18,20})/) // aweme ids are typically 19 digits
              if (m) { rawUrl = `/video/${m[1]}`; break outer }
            }
          }
        }
        const fullUrl = rawUrl.startsWith('http')
          ? rawUrl
          : rawUrl.startsWith('//')
            ? `https:${rawUrl}`
            : (rawUrl ? `https://www.douyin.com${rawUrl}` : '')

        // Parse the published-at text: "3天前" / "2月前" / "1年前" / "10月12日"
        let publishedAt = '刚刚'
        for (const t of leafTexts) {
          const trimmed = t.trim()
          if (/^\d+\s*(分钟|小时|天|周|月|年)前$/.test(trimmed)) {
            publishedAt = trimmed
            break
          }
          if (/^\d+月\d+日$/.test(trimmed)) {
            publishedAt = trimmed
            break
          }
        }

        // Only keep cards where we extracted a real /video/{id} URL.
        // Without a real video id the publisher has no reliable way to reopen
        // the video later — the search-by-title fallback returns 0 candidates
        // for the publishing account most of the time, leading to "无法打开视频页面".
        if (title && /\/video\/\d{15,}/.test(fullUrl)) {
          out.push({
            title,
            likes,
            url: fullUrl,
            publishedAt,
          })
        }
      })

      const seen = new Set<string>()
      const deduped = out.filter(x => {
        if (seen.has(x.title)) return false
        seen.add(x.title)
        return true
      })
      return { items: deduped, debug: debugInfo }

      } catch (e) {
        const errStr = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
        debugInfo.errors.push(errStr)
        return { items: [], debug: debugInfo }
      }
    }, keyword)

      // Merge this batch into the accumulated map (dedupe by URL or title)
      for (const it of batch.items) {
        const key = it.url && !it.url.includes('#') ? it.url : it.title
        if (!accumulated.has(key)) accumulated.set(key, it)
      }
      lastDebug = batch.debug
      const added = accumulated.size - before
      console.log(`[crawl] scroll #${scrollIter}: batch=${batch.items.length}, added=${added}, total=${accumulated.size}`)

      if (added === 0) {
        consecutiveNoNew++
        // After 3 scrolls with no new content, assume we've reached the end
        if (consecutiveNoNew >= 3) {
          console.log(`[crawl] no new items for 3 consecutive scrolls — stopping`)
          break
        }
      } else {
        consecutiveNoNew = 0
      }

      // Stop early if we've hit the requested limit
      if (accumulated.size >= limit) {
        console.log(`[crawl] reached limit ${limit}, stopping`)
        break
      }

      // Scroll a bit further to reveal the next page of virtualized cards
      await page.mouse.wheel(0, 800 + Math.random() * 400)
      await new Promise(r => setTimeout(r, 900 + Math.random() * 500))
    }

    console.log(`[crawl] final count: ${accumulated.size}, last debug:`, JSON.stringify(lastDebug))

    const allItems = Array.from(accumulated.values())
    const results: CrawlResult[] = []
    const hashStr = (s: string): string => {
      let h = 0
      for (let i = 0; i < s.length; i++) {
        h = ((h << 5) - h) + s.charCodeAt(i)
        h |= 0
      }
      return Math.abs(h).toString(36)
    }
    for (let i = 0; i < Math.min(allItems.length, limit); i++) {
      const item = allItems[i]
      // Always use title-hash ID so re-crawling updates the same row (fills in url).
      const id = `dy-${hashStr(item.title)}`
      results.push({
        id,
        platform: 'douyin',
        title: item.title,
        likes: parseNumber(item.likes),
        comments: 0,
        shares: 0,
        published_at: item.publishedAt || '刚刚',
        url: item.url && !item.url.includes('#') ? item.url : undefined,
      })
    }

    // Keep the browser tab open so the user can verify results visually.
    // It will be reused on the next crawl, avoiding fresh-tab anti-bot triggers.
    return { count: results.length, videos: results }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { count: 0, videos: [], message: msg }
  }
}

export async function crawlPlatform(
  accountId: string,
  platform: string,
  keyword: string,
  limit = 20,
  sortBy: SortBy = undefined,
): Promise<CrawlReport> {
  if (platform === 'douyin') return crawlDouyin(accountId, keyword, limit, sortBy)
  if (platform === 'kuaishou') return crawlKuaishou(accountId, keyword, limit, sortBy)
  return { count: 0, videos: [], message: `平台 ${platform} 暂未实现` }
}

// ============================================================================
// Kuaishou crawler
// ============================================================================

async function kuaishouSearch(page: Page, keyword: string, sortBy: SortBy): Promise<void> {
  const log = (msg: string) => console.log(`[crawl-ks] ${msg}`)

  // Land on home first to look human, then go to search.
  const currentUrl = page.url()
  if (!currentUrl.startsWith('https://www.kuaishou.com')) {
    log('navigating to kuaishou home...')
    await page.goto('https://www.kuaishou.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await humanLikeDelay(2000, 3500)
    await page.mouse.wheel(0, 300 + Math.random() * 400)
    await humanLikeDelay(800, 1500)
  }

  // Kuaishou search URL — `searchKey` is the query param the site uses internally.
  // sortBy is currently ignored; the search page exposes filter UI on-page but
  // doesn't accept a URL param for it. We can add UI-driven sorting later.
  const searchUrl = `https://www.kuaishou.com/search/video?searchKey=${encodeURIComponent(keyword)}`
  void sortBy
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
  log(`navigated to: ${searchUrl}`)
  await humanLikeDelay(4000, 6000)
  log(`current url after search: ${page.url()}`)

  for (let i = 0; i < 2; i++) {
    await page.mouse.wheel(0, 800)
    await humanLikeDelay(800, 1200)
  }
}

async function waitForKuaishouResults(page: Page, timeoutMs = 15000): Promise<boolean> {
  // Kuaishou's video cards may not be <a href> — they often use onclick + JS
  // navigation. Wait for thumbnail images to appear instead (more universal).
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (page.isClosed()) return false
    try {
      const info = await page.evaluate(() => ({
        anchors: document.querySelectorAll('a[href*="/short-video/"]').length,
        imgs: document.querySelectorAll('img').length,
        // Look for any element with a photo-id-like attribute
        photoIdAttrs: document.querySelectorAll(
          '[data-photoid], [data-photo-id], [data-photo_id], [photoid]'
        ).length,
      }))
      if (info.anchors >= 3 || info.photoIdAttrs >= 3 || info.imgs >= 8) {
        console.log(`[crawl-ks] search results loaded: anchors=${info.anchors}, imgs=${info.imgs}, photoIdAttrs=${info.photoIdAttrs}`)
        return true
      }
    } catch {}
    await new Promise(r => setTimeout(r, 800))
  }
  return false
}

function formatKuaishouTimestamp(tsMs: number): string {
  if (!tsMs || tsMs <= 0) return '刚刚'
  const now = Date.now()
  const diff = now - tsMs
  if (diff < 0) return '刚刚'
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return '刚刚'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}天前`
  const month = Math.floor(day / 30)
  if (month < 12) return `${month}月前`
  return `${Math.floor(month / 12)}年前`
}

export async function crawlKuaishou(
  accountId: string,
  keyword: string,
  limit = 20,
  sortBy: SortBy = undefined,
): Promise<CrawlReport> {
  void sortBy
  const page = await newPage(accountId)

  // Kuaishou doesn't put photo IDs in the DOM — they live in React state.
  // The only reliable way to extract them is to intercept the GraphQL search
  // responses. Each response carries an array of `feeds`, each with a
  // `photo` object: { id/photoId, caption, realLikeCount, timestamp, ... }.
  type Captured = { photoId: string; title: string; likes: number; timestamp: number }
  const captured: Captured[] = []
  const seenIds = new Set<string>()
  let apiHits = 0
  let parseErrors = 0

  const responseHandler = (resp: import('playwright').Response): void => {
    const url = resp.url()
    if (!url.includes('graphql') && !url.includes('/rest/')) return
    // Fire-and-forget — we don't want to block other event listeners on slow JSON.
    resp.json().then((data: unknown) => {
      apiHits++
      // Walk the response tree looking for feed arrays with `photo` objects.
      // Different operations use different paths (visionSearchPhoto, etc.) so
      // walk recursively rather than hardcoding one path.
      const visit = (node: unknown, depth: number): void => {
        if (depth > 8 || node === null || node === undefined) return
        if (Array.isArray(node)) {
          for (const item of node) visit(item, depth + 1)
          return
        }
        if (typeof node !== 'object') return
        const obj = node as Record<string, unknown>
        // Direct photo shape
        const photo = obj.photo as Record<string, unknown> | undefined
        if (photo && typeof photo === 'object') {
          const pid = (photo.id || photo.photoId) as string | number | undefined
          if (pid) {
            const idStr = String(pid)
            if (!seenIds.has(idStr)) {
              seenIds.add(idStr)
              captured.push({
                photoId: idStr,
                title: String(photo.caption || photo.title || '').trim(),
                likes: Number(photo.realLikeCount || photo.likeCount || 0),
                timestamp: Number(photo.timestamp || 0),
              })
            }
          }
        }
        // Photo-at-this-level shape (e.g. obj IS the photo)
        if (!photo && (obj.id || obj.photoId) && (obj.caption || obj.realLikeCount !== undefined)) {
          const pid = String(obj.id || obj.photoId)
          if (!seenIds.has(pid)) {
            seenIds.add(pid)
            captured.push({
              photoId: pid,
              title: String(obj.caption || obj.title || '').trim(),
              likes: Number(obj.realLikeCount || obj.likeCount || 0),
              timestamp: Number(obj.timestamp || 0),
            })
          }
        }
        for (const key of Object.keys(obj)) visit(obj[key], depth + 1)
      }
      try {
        visit(data, 0)
      } catch {
        parseErrors++
      }
    }).catch(() => { parseErrors++ })
  }
  page.on('response', responseHandler)

  try {
    await kuaishouSearch(page, keyword, sortBy)

    if (await hasCaptcha(page)) {
      console.log('[crawl-ks] Captcha detected, waiting for user to solve...')
      const deadline = Date.now() + 120000
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000))
        if (page.isClosed()) {
          return { count: 0, videos: [], needCaptcha: true, message: '浏览器窗口被关闭，请重新抓取' }
        }
        if (!(await hasCaptcha(page))) {
          console.log('[crawl-ks] Captcha solved')
          break
        }
      }
    }

    // Wait for the first batch of API responses to settle after navigation.
    await new Promise(r => setTimeout(r, 5000))
    console.log(`[crawl-ks] after initial wait: captured=${captured.length}, apiHits=${apiHits}`)

    // Scroll to trigger lazy-loaded pages. Each scroll typically fires a new
    // visionSearchPhoto request with pcursor=N.
    let consecutiveNoNew = 0
    const maxScrolls = 15
    for (let i = 0; i < maxScrolls; i++) {
      if (page.isClosed()) break
      if (captured.length >= limit) {
        console.log(`[crawl-ks] reached limit ${limit}, stopping`)
        break
      }
      const before = captured.length
      await page.mouse.wheel(0, 1500 + Math.random() * 500)
      await new Promise(r => setTimeout(r, 1800 + Math.random() * 800))
      const added = captured.length - before
      console.log(`[crawl-ks] scroll #${i}: added=${added}, captured=${captured.length}, apiHits=${apiHits}`)
      if (added === 0) {
        consecutiveNoNew++
        if (consecutiveNoNew >= 3) {
          console.log('[crawl-ks] no new items for 3 consecutive scrolls — stopping')
          break
        }
      } else {
        consecutiveNoNew = 0
      }
    }

    console.log(`[crawl-ks] final: captured=${captured.length}, apiHits=${apiHits}, parseErrors=${parseErrors}`)

    if (captured.length === 0) {
      return {
        count: 0,
        videos: [],
        message: apiHits === 0
          ? '快手未拦截到任何 GraphQL 响应，可能账号未登录或被风控'
          : `快手 API 拦截到 ${apiHits} 个响应但没解析出视频，可能数据结构变化`,
      }
    }

    // Filter by keyword: keep entries whose title contains any keyword fragment.
    const kwParts = keyword.split(/[\s,/／、]+/).map(p => p.trim()).filter(Boolean)
    const relevant = captured.filter(c => {
      if (!c.title) return false
      if (kwParts.length === 0) return true
      for (const part of kwParts) {
        if (part.length < 2) continue
        for (let j = 0; j <= part.length - 2; j++) {
          if (c.title.includes(part.slice(j, j + 2))) return true
        }
      }
      return false
    })
    console.log(`[crawl-ks] after keyword filter: ${relevant.length} / ${captured.length}`)

    const hashStr = (s: string): string => {
      let h = 0
      for (let i = 0; i < s.length; i++) {
        h = ((h << 5) - h) + s.charCodeAt(i)
        h |= 0
      }
      return Math.abs(h).toString(36)
    }
    const results: CrawlResult[] = []
    for (let i = 0; i < Math.min(relevant.length, limit); i++) {
      const c = relevant[i]
      results.push({
        id: `ks-${hashStr(c.title || c.photoId)}`,
        platform: 'kuaishou',
        title: c.title || '(无标题)',
        likes: c.likes,
        comments: 0,
        shares: 0,
        published_at: formatKuaishouTimestamp(c.timestamp),
        url: `https://www.kuaishou.com/short-video/${c.photoId}`,
      })
    }
    console.log(`[crawl-ks] returning ${results.length} videos`)
    return { count: results.length, videos: results }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { count: 0, videos: [], message: msg }
  } finally {
    try { page.off('response', responseHandler) } catch {}
  }
}

export function saveVideosToDb(videos: CrawlResult[], keyword: string): { inserted: number; updated: number } {
  const existsStmt = db.prepare('SELECT 1 FROM videos WHERE id = ?')
  const stmt = db.prepare(`
    INSERT INTO videos (id, platform, title, likes, comments, shares, published_at, keyword, url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      likes = excluded.likes,
      comments = excluded.comments,
      title = excluded.title,
      url = COALESCE(excluded.url, videos.url)
  `)
  let inserted = 0
  let updated = 0
  const tx = db.transaction((items: CrawlResult[]) => {
    for (const v of items) {
      const wasThere = !!existsStmt.get(v.id)
      stmt.run(v.id, v.platform, v.title, v.likes, v.comments, v.shares, v.published_at, keyword, v.url || null)
      if (wasThere) updated++; else inserted++
    }
  })
  tx(videos)
  return { inserted, updated }
}
