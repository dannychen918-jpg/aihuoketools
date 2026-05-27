import type { Page } from 'playwright'
import { newPage } from './browser.js'
import db, { resetTodayPublishedIfNeeded } from './db.js'

interface PublishConfig {
  enabled: boolean
  intervalMinSec: number
  intervalMaxSec: number
  dailyLimitPerAccount: number
}

const config: PublishConfig = {
  enabled: false,
  intervalMinSec: 180,  // 3 minutes
  intervalMaxSec: 480,  // 8 minutes
  dailyLimitPerAccount: 20,
}

const accountLastPublishAt = new Map<string, number>()
let workerRunning = false

export function setPublishEnabled(enabled: boolean) {
  config.enabled = enabled
  if (enabled && !workerRunning) {
    startWorker()
  }
}

export function setPublishConfig(opts: Partial<PublishConfig>) {
  Object.assign(config, opts)
}

export function getPublishStatus() {
  return { ...config, workerRunning }
}

async function openVideoAsModal(page: Page, videoId: string): Promise<boolean> {
  // Use the ?modal_id= URL pattern — this opens the video as a modal overlay
  // with the comment sidebar on the right (the layout we tested against).
  // Direct /video/{id} navigation gives the "detail page" layout instead,
  // which has no visible comment panel at the same coordinates.
  const modalUrl = `https://www.douyin.com/?modal_id=${videoId}`
  try {
    console.log(`[publish] navigating to modal: ${modalUrl}`)
    await page.goto(modalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(4000)
    const url = page.url()
    if (/modal_id=\d+/.test(url)) {
      console.log(`[publish] modal opened: ${url}`)
      return true
    }
    console.log(`[publish] modal_id stripped from url: ${url}`)
    return false
  } catch (e) {
    console.log(`[publish] modal nav failed: ${e instanceof Error ? e.message : e}`)
    return false
  }
}

async function findAndOpenVideo(page: Page, videoTitle: string, originalUrl: string): Promise<boolean> {
  // If we have a real video URL, extract the ID and open as modal
  if (originalUrl && !originalUrl.includes('#')) {
    const m = originalUrl.match(/\/video\/(\d+)/)
    if (m) {
      const ok = await openVideoAsModal(page, m[1])
      if (ok) return true
      console.log('[publish] modal open failed, falling back to search')
    }
  }

  // Search by title — use the first plain-text chunk before any hashtag
  const cleanTitle = videoTitle.replace(/#\S+/g, '').replace(/\s+/g, ' ').trim() || videoTitle
  const searchTerm = cleanTitle.slice(0, 25)
  console.log(`[publish] searching for: "${searchTerm}"`)

  try {
    await page.goto(`https://www.douyin.com/search/${encodeURIComponent(searchTerm)}?type=video`, {
      waitUntil: 'domcontentloaded', timeout: 30000,
    })
    await page.waitForTimeout(5000)

    // Find best matching video on the search page. Douyin no longer uses
    // <a href="/video/{id}"> on search results — instead video IDs live in
    // data-* attributes on the cards. Extract candidate (cardElement, videoId)
    // pairs, then score by 3-gram overlap of the title against card text.
    const targetMatch = await page.evaluate((title: string) => {
      const titleLower = title.toLowerCase()

      // Collect candidates: each card root with a discovered video id.
      const candidates: Array<{ id: string; text: string }> = []

      // Strategy A: descendant <a href="/video/{id}"> (legacy)
      const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/video/"]'))
      for (const a of links) {
        const m = (a.getAttribute('href') || '').match(/\/video\/(\d+)/)
        if (!m) continue
        let cardText = a.textContent || ''
        let cur: HTMLElement | null = a.parentElement
        for (let i = 0; i < 5 && cur; i++) {
          const t = cur.textContent || ''
          if (t.length > cardText.length && t.length < 2000) cardText = t
          cur = cur.parentElement
        }
        candidates.push({ id: m[1], text: cardText })
      }

      // Strategy B: <li> cards with video id in data-* attributes
      if (candidates.length === 0) {
        const cards = Array.from(document.querySelectorAll<HTMLElement>('li'))
        for (const card of cards) {
          if (!card.querySelector('img')) continue
          let foundId = ''
          const inner = card.querySelectorAll<HTMLElement>('*')
          outer: for (const el of inner) {
            for (const attr of el.getAttributeNames()) {
              const v = el.getAttribute(attr) || ''
              const m = v.match(/(\d{18,20})/)
              if (m) { foundId = m[1]; break outer }
            }
          }
          if (foundId) {
            candidates.push({ id: foundId, text: card.textContent || '' })
          }
        }
      }

      let bestId = ''
      let bestScore = 0
      let bestText = ''
      for (const c of candidates) {
        const lower = c.text.toLowerCase()
        let score = 0
        for (let i = 0; i <= titleLower.length - 3; i++) {
          const chunk = titleLower.slice(i, i + 3)
          if (!chunk.trim() || chunk.length < 3) continue
          if (lower.includes(chunk)) score++
        }
        if (score > bestScore) {
          bestScore = score
          bestId = c.id
          bestText = c.text.slice(0, 60)
        }
      }
      return { id: bestId, score: bestScore, sample: bestText, candidateCount: candidates.length }
    }, cleanTitle)

    console.log(`[publish] match result: score=${targetMatch.score}, candidates=${targetMatch.candidateCount}, sample="${targetMatch.sample}"`)

    if (!targetMatch.id || targetMatch.score < 3) {
      console.log('[publish] no good match found on search page')
      return false
    }

    return await openVideoAsModal(page, targetMatch.id)
  } catch (e) {
    console.error('[publish] findAndOpenVideo error:', e instanceof Error ? e.message : e)
    return false
  }
}

async function openCommentPanel(page: Page): Promise<boolean> {
  // The comment input is in a side panel that needs to be opened by clicking
  // the comment icon on the right side action bar.
  console.log('[publish] looking for comment icon to open panel...')
  await page.waitForTimeout(2000)

  // Check if comment panel is already open
  const alreadyOpen = await page.evaluate(() => {
    // Look for an input with "评论" placeholder visible
    const inputs = document.querySelectorAll('div[contenteditable="true"]')
    for (const el of inputs) {
      const ph = el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || ''
      if (/评论|说点什么/.test(ph)) {
        const rect = (el as HTMLElement).getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) return true
      }
    }
    return false
  })
  if (alreadyOpen) {
    console.log('[publish] comment panel already open')
    return true
  }

  // Try up to 3 strategies to open the comment panel
  const clicked = await page.evaluate(() => {
    // Strategy 1: data-e2e attribute containing "comment"
    const e2eCandidates = document.querySelectorAll('[data-e2e*="comment" i]')
    for (const el of e2eCandidates) {
      const rect = (el as HTMLElement).getBoundingClientRect()
      if (rect.width > 10 && rect.height > 10) {
        ;(el as HTMLElement).click()
        return 'e2e'
      }
    }

    // Strategy 2: find an element whose text is just a number AND is on the right side
    const allEls = Array.from(document.querySelectorAll<HTMLElement>('*'))
    const candidates: { el: HTMLElement; rect: DOMRect }[] = []
    for (const el of allEls) {
      const t = (el.textContent || '').trim()
      if (!/^\d+$/.test(t)) continue
      if (el.children.length > 2) continue
      const rect = el.getBoundingClientRect()
      // Right side action bar items are typically on the right edge
      if (rect.left > window.innerWidth * 0.7 && rect.width < 100 && rect.height < 100) {
        candidates.push({ el, rect })
      }
    }
    // Sort by Y position — comment icon is usually below like
    candidates.sort((a, b) => a.rect.top - b.rect.top)
    for (const { el } of candidates) {
      // Try clicking nearby clickable ancestor
      let cur: HTMLElement | null = el
      for (let i = 0; i < 4 && cur; i++) {
        cur.click()
        cur = cur.parentElement
      }
      return 'sidebar'
    }

    // Strategy 3: look for SVG icons on the right side and click them
    const svgs = Array.from(document.querySelectorAll<HTMLElement>('svg'))
    const svgCandidates: { el: HTMLElement; rect: DOMRect }[] = []
    for (const svg of svgs) {
      const rect = svg.getBoundingClientRect()
      if (rect.left > window.innerWidth * 0.7 && rect.width > 15 && rect.width < 50 && rect.height > 15 && rect.height < 50) {
        svgCandidates.push({ el: svg, rect })
      }
    }
    // Sort by Y — comment icon is usually 2nd from top (like → comment)
    svgCandidates.sort((a, b) => a.rect.top - b.rect.top)
    if (svgCandidates.length >= 2) {
      const target = svgCandidates[1]
      target.el.click()
      return 'svg-icon'
    }

    return 'none'
  })
  console.log(`[publish] comment icon click result: ${clicked}`)
  await page.waitForTimeout(2500)
  return clicked !== 'none'
}

async function locateDouyinCommentInput(page: Page): Promise<{ x: number; y: number } | null> {
  return page.evaluate(() => {
    // Strategy 1: contenteditable div with comment placeholder
    const editables = document.querySelectorAll<HTMLElement>('div[contenteditable="true"]')
    for (const el of editables) {
      const ph = el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || ''
      if (/评论|说点什么/.test(ph)) {
        const r = el.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) continue
        if (r.left < window.innerWidth * 0.5) continue
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      }
    }
    // Strategy 2: look for any contenteditable div on the right side that could be input
    const fallbacks = document.querySelectorAll<HTMLElement>('div[contenteditable="true"]')
    for (const el of fallbacks) {
      const r = el.getBoundingClientRect()
      if (r.width < 50 || r.height < 20) continue
      if (r.left < window.innerWidth * 0.5) continue
      // Must be near bottom of viewport
      if (r.top < window.innerHeight * 0.7) continue
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }
    return null
  })
}

async function locateDouyinSubmitButton(page: Page, inputCenter: { x: number; y: number }): Promise<{ cx: number; cy: number } | null> {
  return page.evaluate((ic: { x: number; y: number }) => {
    const candidates: Array<{ cx: number; cy: number; dist: number }> = []
    const all = document.querySelectorAll<HTMLElement>('button, [role="button"], span, div, a')
    for (const el of all) {
      const t = (el.textContent || '').trim()
      if (t.length === 0 || t.length > 4) continue
      const tn = t.replace(/\s+/g, '')
      if (tn !== '发布' && tn !== '发送') continue
      const rect = el.getBoundingClientRect()
      if (rect.width < 20 || rect.height < 15 || rect.width > 200) continue
      if (rect.left < window.innerWidth * 0.5) continue
      const style = window.getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') continue
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      const dx = cx - ic.x
      const dy = cy - ic.y
      candidates.push({ cx, cy, dist: Math.sqrt(dx * dx + dy * dy) })
    }
    candidates.sort((a, b) => a.dist - b.dist)
    return candidates.length > 0 ? candidates[0] : null
  }, inputCenter)
}

async function postComment(page: Page, content: string): Promise<boolean> {
  // Step 1: open the comment panel — if it fails, abort immediately
  const panelOpened = await openCommentPanel(page)
  if (!panelOpened) {
    console.log('[publish] comment panel could not be opened — abort')
    return false
  }

  // Step 2: locate comment input via DOM (preferred) or fallback to coordinates
  let inputPos = await locateDouyinCommentInput(page)
  if (!inputPos) {
    console.log('[publish] DOM input not found, falling back to fixed coordinates...')
    const viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }))
    const x = viewport.width * 0.87
    const y = viewport.height * 0.96
    console.log(`[publish] viewport=${viewport.width}x${viewport.height}, clicking at (${x}, ${y})`)
    await page.mouse.move(x, y, { steps: 5 })
    await page.waitForTimeout(300 + Math.random() * 300)
    await page.mouse.click(x, y)
  } else {
    console.log(`[publish] clicking DOM-located comment input at (${inputPos.x.toFixed(0)}, ${inputPos.y.toFixed(0)})`)
    await page.mouse.move(inputPos.x, inputPos.y, { steps: 5 })
    await page.waitForTimeout(300 + Math.random() * 300)
    await page.mouse.click(inputPos.x, inputPos.y)
  }
  await page.waitForTimeout(1500)

  // Step 3: verify focus landed on a comment-like element before typing
  const focusCheck = await page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null
    if (!a) return { ok: false, reason: 'no activeElement' }
    const tag = a.tagName?.toLowerCase() || ''
    const editable = a.getAttribute('contenteditable') === 'true'
    const isInput = tag === 'textarea' || tag === 'input' || editable
    const ph = a.getAttribute('data-placeholder') || a.getAttribute('placeholder') || ''
    const matchesPlaceholder = /评论|说点什么/.test(ph)
    const textLen = ((a as HTMLInputElement).value || a.textContent || '').length
    return { ok: isInput && textLen < 100, tag, editable, ph: ph.slice(0, 30), textLen }
  })
  console.log(`[publish] focus check: ${JSON.stringify(focusCheck)}`)
  if (focusCheck && !focusCheck.ok) {
    // If focus missed the input, try clicking the DOM input one more time
    const retryPos = await locateDouyinCommentInput(page)
    if (retryPos) {
      console.log(`[publish] retrying DOM click at (${retryPos.x.toFixed(0)}, ${retryPos.y.toFixed(0)})`)
      await page.mouse.click(retryPos.x, retryPos.y)
      await page.waitForTimeout(1200)
    }
  }

  console.log('[publish] typing comment...')
  try {
    for (const ch of content) {
      await page.keyboard.type(ch, { delay: 60 + Math.random() * 100 })
    }
    await page.waitForTimeout(1200 + Math.random() * 800)

    // Check what was actually typed (for diagnostics)
    const typed = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null
      if (!active) return ''
      return (active as HTMLInputElement).value || active.textContent || ''
    })
    console.log(`[publish] active element content after typing: "${typed.slice(0, 60)}"`)

    // Check if typed text looks like the accessibility overlay (screen-reader mode)
    const isOverlayTyped = /开启读屏|读屏标签|精选推荐搜索/.test(typed.slice(0, 30))
    if (isOverlayTyped) {
      console.log('[publish] typed into accessibility overlay instead of comment input — will retry')
    }

    // Step 4: submit — try both button click AND Enter for maximum reliability
    const submitBtn = inputPos ? await locateDouyinSubmitButton(page, inputPos) : null
    let submittedViaButton = false
    if (submitBtn) {
      console.log(`[publish] clicking submit button at (${submitBtn.cx.toFixed(0)}, ${submitBtn.cy.toFixed(0)})`)
      await page.mouse.click(submitBtn.cx, submitBtn.cy)
      await page.waitForTimeout(500)
      submittedViaButton = true
    }

    // Always also press Enter as a secondary submission mechanism
    console.log('[publish] pressing Enter to submit')
    await page.keyboard.press('Enter')

    // Step 5: verify submission up to 3 times
    let verification: {
      inputFound: boolean; inputCleared: boolean; inputText: string
      inList: boolean; blocked: boolean; snippets: string[]
    } | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.waitForTimeout(attempt === 0 ? 3500 : 2000)
      verification = await page.evaluate((expectedText: string) => {
        const EMOJI_RE = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}️‍]/gu
        const stripped = expectedText.replace(EMOJI_RE, ' ').replace(/\s+/g, ' ').trim()
        const chunks = stripped.split(/\s+/)
          .map(s => s.replace(/[\s　]+/g, ''))
          .filter(s => s.length >= 6)
          .sort((a, b) => b.length - a.length)
          .slice(0, 4)

        let inputFound = false
        let inputCleared = false
        let inputText = ''
        const inputs = document.querySelectorAll<HTMLElement>('div[contenteditable="true"]')
        for (const el of inputs) {
          const ph = el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || ''
          if (/评论|说点什么/.test(ph)) {
            inputFound = true
            inputText = (el.textContent || '').replace(/\s+/g, '')
            if (inputText.length === 0) inputCleared = true
            break
          }
        }
        const bodyText = (document.body?.innerText || '').replace(/\s+/g, '')
        const inList = chunks.some(c => bodyText.includes(c))
        const BLOCK_RE = /操作过快|稍后再试|评论失败|发布失败|不能频繁|系统繁忙|无法发布|评论被拒|发送失败|你的评论/
        let blocked = false
        const overlays = document.querySelectorAll<HTMLElement>('div, section')
        for (const el of overlays) {
          const t = (el.textContent || '').trim()
          if (t.length === 0 || t.length > 80) continue
          const style = window.getComputedStyle(el)
          if (style.position !== 'fixed' && style.position !== 'absolute') continue
          if (style.display === 'none' || style.visibility === 'hidden') continue
          const rect = el.getBoundingClientRect()
          if (rect.width === 0 || rect.height === 0) continue
          if (rect.width > window.innerWidth * 0.8) continue
          if (BLOCK_RE.test(t)) { blocked = true; break }
        }
        return { inputFound, inputCleared, inputText: inputText.slice(0, 60), inList, blocked, snippets: chunks }
      }, content)
      console.log(`[publish] verify attempt ${attempt + 1}:`, JSON.stringify(verification))
      if (verification.blocked) {
        console.log('[publish] anti-spam / rate-limit detected → fail')
        return false
      }
      if (verification.inputFound && verification.inputCleared) return true
      if (verification.inList) return true
    }

    console.log('[publish] post not verified after 3 attempts — declaring fail')
    return false
  } catch (e) {
    console.error('[publish] post comment error:', e instanceof Error ? e.message : e)
    return false
  }
}

// ============================================================================
// Kuaishou publisher — mirrors the Douyin functions above, but uses Kuaishou's
// URL pattern (`/short-video/{photoId}`) and right-side comment panel layout.
// ============================================================================

async function findAndOpenKuaishouVideo(page: Page, originalUrl: string): Promise<boolean> {
  if (!originalUrl) {
    console.log('[publish-ks] no url on this video — cannot open')
    return false
  }
  const m = originalUrl.match(/\/short-video\/([A-Za-z0-9_-]{8,})/)
  if (!m) {
    console.log(`[publish-ks] url does not look like a short-video link: ${originalUrl}`)
    return false
  }
  const photoId = m[1]
  const target = `https://www.kuaishou.com/short-video/${photoId}`
  try {
    console.log(`[publish-ks] navigating to: ${target}`)
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(4000)
    const url = page.url()
    if (/\/short-video\//.test(url)) {
      console.log(`[publish-ks] page opened: ${url}`)
      return true
    }
    console.log(`[publish-ks] navigation landed elsewhere: ${url}`)
    return false
  } catch (e) {
    console.log(`[publish-ks] nav failed: ${e instanceof Error ? e.message : e}`)
    return false
  }
}

async function openCommentPanelKuaishou(page: Page): Promise<boolean> {
  console.log('[publish-ks] looking for comment icon to open panel...')
  await page.waitForTimeout(2000)

  const alreadyOpen = await page.evaluate(() => {
    const inputs = document.querySelectorAll('div[contenteditable="true"], textarea, input[type="text"]')
    for (const el of inputs) {
      const ph = el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || ''
      if (/评论|说点什么/.test(ph)) {
        const rect = (el as HTMLElement).getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) return true
      }
    }
    return false
  })
  if (alreadyOpen) {
    console.log('[publish-ks] comment panel already open')
    return true
  }

  // Click the comment icon on the right action bar. Kuaishou's layout matches
  // Douyin's general pattern (numeric count under the icon, right edge of screen).
  const clicked = await page.evaluate(() => {
    // Kuaishou doesn't reliably use data-e2e — go straight to the geometric search.
    const allEls = Array.from(document.querySelectorAll<HTMLElement>('*'))
    const candidates: { el: HTMLElement; rect: DOMRect }[] = []
    for (const el of allEls) {
      const t = (el.textContent || '').trim()
      // Match plain numbers or numbers with 万/w suffix (e.g. "1.5万", "238")
      if (!/^[\d.]+[万wKk]?$/.test(t)) continue
      if (el.children.length > 2) continue
      const rect = el.getBoundingClientRect()
      // Right-side action bar items live near the right edge
      if (rect.left > window.innerWidth * 0.65 && rect.width < 120 && rect.height < 80) {
        candidates.push({ el, rect })
      }
    }
    // Sort by Y position — comment icon is usually 2nd from top (like → comment → favorite → share)
    candidates.sort((a, b) => a.rect.top - b.rect.top)

    // Click the 2nd candidate if we have 3+ (typical action-bar layout);
    // otherwise click each in turn — the panel toggle will be the comment one.
    const targetList = candidates.length >= 3 ? [candidates[1]] : candidates
    for (const { el } of targetList) {
      let cur: HTMLElement | null = el
      for (let i = 0; i < 4 && cur; i++) {
        cur.click()
        cur = cur.parentElement
      }
      return 'right-action-bar'
    }
    return 'none'
  })
  console.log(`[publish-ks] comment icon click result: ${clicked}`)
  await page.waitForTimeout(2500)
  return clicked !== 'none'
}

async function locateKuaishouCommentInput(page: Page): Promise<{ x: number; y: number } | null> {
  return page.evaluate(() => {
    const candidates = document.querySelectorAll<HTMLElement>(
      'div[contenteditable="true"], textarea, input[type="text"]'
    )
    for (const el of candidates) {
      const ph = el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || ''
      if (!/评论|说点什么/.test(ph)) continue
      const r = el.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) continue
      // Kuaishou input lives on the right column — guard against accidentally
      // matching a search box on the left.
      if (r.left < window.innerWidth * 0.5) continue
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }
    return null
  })
}

async function postCommentKuaishou(page: Page, content: string): Promise<boolean> {
  // Anti-bot pre-check: Kuaishou serves a degraded "浏览器版本过低" page when
  // it detects automation, even with stealth init. The real comment UI never
  // loads — no point trying to type into it.
  const degraded = await page.evaluate(() => {
    const t = (document.body?.innerText || '').slice(0, 1000)
    return /浏览器版本过低|建议及时更新|点击重试/.test(t)
  })
  if (degraded) {
    console.log('[publish-ks] page degraded by anti-bot ("浏览器版本过低") — abort')
    return false
  }

  // Locate the actual comment input element by its placeholder. Kuaishou's
  // input lives on the upper-right (just below the video meta), NOT the
  // bottom-right like Douyin. The exact pixel position depends on video meta
  // length, so we read getBoundingClientRect() rather than guessing.
  let inputPos = await locateKuaishouCommentInput(page)
  if (!inputPos) {
    console.log('[publish-ks] input not found on first look — trying to open comment panel')
    await openCommentPanelKuaishou(page)
    inputPos = await locateKuaishouCommentInput(page)
  }
  if (!inputPos) {
    console.log('[publish-ks] no comment input element found anywhere — abort')
    return false
  }
  console.log(`[publish-ks] clicking comment input at (${inputPos.x.toFixed(0)}, ${inputPos.y.toFixed(0)})`)

  await page.mouse.move(inputPos.x, inputPos.y, { steps: 5 })
  await page.waitForTimeout(300 + Math.random() * 300)
  await page.mouse.click(inputPos.x, inputPos.y)
  await page.waitForTimeout(1200)

  // Confirm focus landed on a real comment input before typing. Without this
  // check, a missing/displaced input still "succeeds" because page.keyboard.type
  // sends keys to body and silent inputs.
  const focused = await page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null
    if (!a) return { ok: false, reason: 'no activeElement' }
    const tag = a.tagName?.toLowerCase() || ''
    const editable = a.getAttribute('contenteditable') === 'true'
    const isInput = tag === 'textarea' || tag === 'input' || editable
    const ph = a.getAttribute('data-placeholder') || a.getAttribute('placeholder') || ''
    const matchesPlaceholder = /评论|说点什么/.test(ph)
    return { ok: isInput && matchesPlaceholder, tag, editable, ph: ph.slice(0, 30) }
  })
  console.log(`[publish-ks] focus check: ${JSON.stringify(focused)}`)
  if (!focused.ok) {
    console.log('[publish-ks] click did not focus a comment input — abort')
    return false
  }

  console.log('[publish-ks] typing comment...')
  try {
    for (const ch of content) {
      await page.keyboard.type(ch, { delay: 60 + Math.random() * 100 })
    }
    await page.waitForTimeout(1200 + Math.random() * 800)

    const typed = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null
      if (!active) return ''
      return (active as HTMLInputElement).value || active.textContent || ''
    })
    console.log(`[publish-ks] active element content after typing: "${typed.slice(0, 50)}"`)

    // Find the submit button. Kuaishou uses a <textarea> (not contenteditable),
    // so Enter only inserts a newline — we MUST find and click the real button.
    // Strategy: pick the closest "发送"/"发布" element to the comment input box,
    // then issue a real mouse click on its center so React mousedown/mouseup
    // synthetic events fire (element.click() doesn't trigger those).
    const submitInfo = await page.evaluate((inputCenter: { x: number; y: number }) => {
      const candidates: Array<{ cx: number; cy: number; dist: number; text: string; w: number; h: number }> = []
      const all = document.querySelectorAll<HTMLElement>('button, [role="button"], span, div, a')
      for (const el of all) {
        // Use ONLY the element's own short trimmed text — `textContent` includes
        // descendant text, which makes a wrapping <div>发送</div> appear as a
        // 50-char string from a sibling icon's aria-label etc.
        const t = (el.textContent || '').trim()
        if (t.length === 0 || t.length > 4) continue
        // Strip whitespace inside the text (e.g. "发 送")
        const tn = t.replace(/\s+/g, '')
        if (tn !== '发送' && tn !== '发布' && tn !== '提交') continue
        const rect = el.getBoundingClientRect()
        if (rect.width < 20 || rect.height < 15 || rect.width > 200) continue
        if (rect.left < window.innerWidth * 0.5) continue
        const style = window.getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden') continue
        if (style.pointerEvents === 'none') continue
        const cx = rect.left + rect.width / 2
        const cy = rect.top + rect.height / 2
        const dx = cx - inputCenter.x
        const dy = cy - inputCenter.y
        candidates.push({ cx, cy, dist: Math.sqrt(dx * dx + dy * dy), text: tn, w: rect.width, h: rect.height })
      }
      candidates.sort((a, b) => a.dist - b.dist)
      return { picked: candidates[0] || null, count: candidates.length }
    }, inputPos)

    console.log(`[publish-ks] submit candidates=${submitInfo.count}, picked=${JSON.stringify(submitInfo.picked)}`)

    // Dual submission strategy:
    // 1. If submit button found: mouse click + native DOM event dispatch
    // 2. Always try Ctrl+Enter as fallback (some React bindings need both)
    if (submitInfo.picked) {
      // Method A: Real mouse click triggers mousedown/mouseup/click sequence
      await page.mouse.move(submitInfo.picked.cx, submitInfo.picked.cy, { steps: 3 })
      await page.waitForTimeout(150)
      await page.mouse.click(submitInfo.picked.cx, submitInfo.picked.cy)
      await page.waitForTimeout(300)

      // Method B: Native DOM event dispatch — some React bindings only respond
      // to programmatic dispatchEvent() with proper initialization.
      await page.evaluate((pickCx, pickCy) => {
        const el = document.elementFromPoint(pickCx, pickCy) as HTMLElement | null
        if (el) {
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }))
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
          el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
          el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }))
        }
      }, submitInfo.picked.cx, submitInfo.picked.cy)
    } else {
      console.log('[publish-ks] no submit button found, trying Ctrl+Enter')
      await page.keyboard.press('Control+Enter')
    }

    // Also try Ctrl+Enter as secondary mechanism regardless
    await page.keyboard.press('Control+Enter')

    // Verify up to 3 times. Unlike Douyin, we do NOT use "inList" as a fallback:
    // AI-generated comments share topic words (直播运营 / 新媒体 / etc.) with the
    // video title and description, so a substring-on-body check is a near-guaranteed
    // false positive. Require the comment input to actually clear.
    let verification: {
      inputFound: boolean; inputCleared: boolean; inputText: string
      blocked: boolean
    } | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.waitForTimeout(attempt === 0 ? 3500 : 2000)
      verification = await page.evaluate(() => {
        let inputFound = false
        let inputCleared = false
        let inputText = ''
        const inputs = document.querySelectorAll<HTMLElement>('div[contenteditable="true"], textarea, input[type="text"]')
        for (const el of inputs) {
          const ph = el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || ''
          if (/评论|说点什么/.test(ph)) {
            inputFound = true
            const v = (el as HTMLInputElement).value || el.textContent || ''
            inputText = v.replace(/\s+/g, '')
            if (inputText.length === 0) inputCleared = true
            break
          }
        }
        const BLOCK_RE = /操作过快|稍后再试|评论失败|发布失败|不能频繁|系统繁忙|无法发布|评论被拒|发送失败|你的评论/
        let blocked = false
        const overlays = document.querySelectorAll<HTMLElement>('div, section')
        for (const el of overlays) {
          const t = (el.textContent || '').trim()
          if (t.length === 0 || t.length > 80) continue
          const style = window.getComputedStyle(el)
          if (style.position !== 'fixed' && style.position !== 'absolute') continue
          if (style.display === 'none' || style.visibility === 'hidden') continue
          const rect = el.getBoundingClientRect()
          if (rect.width === 0 || rect.height === 0) continue
          if (rect.width > window.innerWidth * 0.8) continue
          if (BLOCK_RE.test(t)) { blocked = true; break }
        }
        return { inputFound, inputCleared, inputText: inputText.slice(0, 60), blocked }
      })
      console.log(`[publish-ks] verify attempt ${attempt + 1}:`, JSON.stringify(verification))
      if (verification.blocked) {
        console.log('[publish-ks] anti-spam / rate-limit detected → fail')
        return false
      }
      if (verification.inputFound && verification.inputCleared) return true
    }

    console.log('[publish-ks] post not verified after 3 attempts — declaring fail')
    return false
  } catch (e) {
    console.error('[publish-ks] post comment error:', e instanceof Error ? e.message : e)
    return false
  }
}

async function publishOne(task: {
  id: string; account_id: string; video_id: string; comment_content: string
}): Promise<{ ok: boolean; error?: string }> {
  // Fetch the target video
  const video = db.prepare('SELECT id, title, url, platform FROM videos WHERE id = ?').get(task.video_id) as {
    id: string; title: string; url?: string; platform: string
  } | undefined
  if (!video) return { ok: false, error: '视频不存在' }
  console.log(`[publish] task ${task.id}: platform=${video.platform} video="${video.title.slice(0, 30)}..." url="${video.url || '(none)'}"`)

  // Mark publishing
  db.prepare('UPDATE publish_tasks SET status = ? WHERE id = ?').run('publishing', task.id)

  let page: Page
  try {
    page = await newPage(task.account_id)
  } catch (e) {
    db.prepare('UPDATE publish_tasks SET status = ? WHERE id = ?').run('error', task.id)
    return { ok: false, error: '账号浏览器启动失败' }
  }

  try {
    const opened = video.platform === 'kuaishou'
      ? await findAndOpenKuaishouVideo(page, video.url || '')
      : await findAndOpenVideo(page, video.title, video.url || '')
    if (!opened) {
      db.prepare('UPDATE publish_tasks SET status = ? WHERE id = ?').run('error', task.id)
      return { ok: false, error: '无法打开视频页面' }
    }

    const posted = video.platform === 'kuaishou'
      ? await postCommentKuaishou(page, task.comment_content)
      : await postComment(page, task.comment_content)
    if (!posted) {
      db.prepare('UPDATE publish_tasks SET status = ? WHERE id = ?').run('error', task.id)
      return { ok: false, error: '评论提交失败' }
    }

    db.prepare('UPDATE publish_tasks SET status = ? WHERE id = ?').run('completed', task.id)
    db.prepare('UPDATE accounts SET today_published = today_published + 1 WHERE id = ?').run(task.account_id)
    // Persistent "video has been published" counter — survives task deletion
    db.prepare('UPDATE videos SET published_count = COALESCE(published_count, 0) + 1 WHERE id = ?').run(task.video_id)
    accountLastPublishAt.set(task.account_id, Date.now())
    return { ok: true }
  } catch (e) {
    db.prepare('UPDATE publish_tasks SET status = ? WHERE id = ?').run('error', task.id)
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    // Park the page on about:blank to release the video player, comment list
    // and any side-panel DOM. Without this, every account leaves a heavy
    // Douyin modal tab playing in the background and memory/CPU keeps climbing.
    try {
      await page.goto('about:blank', { timeout: 5000 }).catch(() => {})
    } catch {}
  }
}

function nextEligibleTask(): { id: string; account_id: string; video_id: string; comment_content: string } | null {
  // Roll today_published back to 0 the first time we pick a task after midnight.
  resetTodayPublishedIfNeeded()
  const tasks = db.prepare(`
    SELECT t.id, t.account_id, t.video_id, t.comment_content, a.today_published, a.daily_limit, a.status as account_status
    FROM publish_tasks t
    JOIN accounts a ON t.account_id = a.id
    WHERE t.status = 'pending'
    ORDER BY t.created_at ASC
  `).all() as Array<{
    id: string; account_id: string; video_id: string; comment_content: string
    today_published: number; daily_limit: number; account_status: string
  }>

  const now = Date.now()
  for (const t of tasks) {
    if (t.account_status !== 'online') continue
    if (t.today_published >= t.daily_limit) continue
    const last = accountLastPublishAt.get(t.account_id) || 0
    const minInterval = config.intervalMinSec * 1000
    if (now - last < minInterval) continue
    return { id: t.id, account_id: t.account_id, video_id: t.video_id, comment_content: t.comment_content }
  }
  return null
}

async function startWorker() {
  if (workerRunning) return
  workerRunning = true
  console.log('[publish] worker started')

  while (config.enabled) {
    try {
      const task = nextEligibleTask()
      if (!task) {
        await new Promise(r => setTimeout(r, 10000))
        continue
      }
      console.log(`[publish] publishing task ${task.id} for account ${task.account_id}`)
      const result = await publishOne(task)
      console.log(`[publish] task ${task.id} result:`, result)

      // Random wait between intervalMin and intervalMax
      const wait = config.intervalMinSec * 1000 +
        Math.random() * (config.intervalMaxSec - config.intervalMinSec) * 1000
      console.log(`[publish] sleeping ${Math.round(wait / 1000)}s before next task`)
      await new Promise(r => setTimeout(r, wait))
    } catch (e) {
      console.error('[publish] worker error:', e)
      await new Promise(r => setTimeout(r, 5000))
    }
  }

  workerRunning = false
  console.log('[publish] worker stopped')
}
