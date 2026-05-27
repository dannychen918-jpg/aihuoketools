import { create } from 'zustand'
import type { Video, Account, PublishTask, CommentStyle, GeneratedComment, Platform } from './types'
import { api } from './api'

interface Filters {
  keyword: string
  platforms: Platform[]
  sortBy: 'all' | 'recent' | 'likes' | 'comments'
  minLikes: number
  commentActivity: 'any' | 'high' | 'medium' | 'low'
  fanProfile: string
}

interface Store {
  activeTab: 'filter' | 'comment' | 'account'
  setActiveTab: (tab: 'filter' | 'comment' | 'account') => void

  // Video filter
  filters: Filters
  setFilter: <K extends keyof Filters>(key: K, value: Filters[K]) => void
  togglePlatform: (p: Platform) => void
  videos: Video[]
  fetchedCount: number
  videoStats: { total: number; commented: number; pending: number }
  isFetching: boolean
  fetchWarnings: string[]
  lastFetchSummary: string  // human-readable: "刚刚抓取完成，新增 5 条" / "抓取中..." / ""
  loadExistingVideos: () => Promise<void>
  loadVideoStats: () => Promise<void>
  startFetch: () => void
  toggleVideoSelect: (id: string) => void
  selectAllVideos: () => void
  deleteSelectedVideos: () => Promise<void>

  // Comment generation
  commentStyle: CommentStyle
  setCommentStyle: (s: CommentStyle) => void
  commentNote: string
  setCommentNote: (n: string) => void
  generatedComments: GeneratedComment[]
  isGenerating: boolean
  generationProgress: { current: number; total: number }
  loadExistingComments: () => Promise<void>
  generateComments: () => void
  regenerateComment: (id: string) => void
  editComment: (id: string, content: string) => void
  dispatchToPublishQueue: () => Promise<void>
  dispatchStatus: string

  // Account management
  accounts: Account[]
  publishTasks: PublishTask[]
  dailyLimitPerAccount: number
  commentInterval: string
  rotationMode: string
  isPublishing: boolean
  setDailyLimit: (n: number) => void
  setCommentInterval: (v: string) => void
  setRotationMode: (v: string) => void
  togglePublishing: () => Promise<void>
  loadPublishStatus: () => Promise<void>
  cancelTask: (id: string) => void
  clearCompletedTasks: () => Promise<void>
  clearErrorTasks: () => Promise<void>
  loadAccounts: () => void
  loadTasks: () => void

  // Login & account add
  showAddModal: boolean
  setShowAddModal: (v: boolean) => void
  addingAccountStatus: string
  addingAccountError: string | null
  addAccount: (name: string, platform: Platform) => Promise<void>
  deleteAccount: (id: string) => Promise<void>
  relogin: (accountId: string) => Promise<void>
}

const TAB_KEY = 'aihuoke:activeTab'
const initialTab = ((): 'filter' | 'comment' | 'account' => {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(TAB_KEY) : null
    if (v === 'filter' || v === 'comment' || v === 'account') return v
  } catch {}
  return 'filter'
})()

const SETTINGS_KEY = 'aihuoke:settings'
type Settings = { dailyLimitPerAccount?: number; commentInterval?: string; rotationMode?: string }
function loadSettings(): Settings {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SETTINGS_KEY) : null
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}
function saveSettings(partial: Settings) {
  try {
    const cur = loadSettings()
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...cur, ...partial }))
  } catch {}
}
const savedSettings = loadSettings()

const FETCH_SUMMARY_KEY = 'aihuoke:lastFetchSummary'
const initialFetchSummary = ((): string => {
  try {
    if (typeof localStorage === 'undefined') return ''
    const v = localStorage.getItem(FETCH_SUMMARY_KEY) || ''
    // If a stale "正在抓取..." leaked into localStorage (HMR mid-crawl), drop it
    if (v.startsWith('正在抓取')) {
      try { localStorage.removeItem(FETCH_SUMMARY_KEY) } catch {}
      return ''
    }
    return v
  } catch { return '' }
})()

const FILTERS_KEY = 'aihuoke:filters'
function loadSavedFilters(): Partial<Filters> {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(FILTERS_KEY) : null
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}
function saveFiltersToStorage(filters: Filters) {
  try { localStorage.setItem(FILTERS_KEY, JSON.stringify(filters)) } catch {}
}
const savedFilters = loadSavedFilters()

export const useStore = create<Store>((set, get) => ({
  activeTab: initialTab,
  setActiveTab: (tab) => {
    try { localStorage.setItem(TAB_KEY, tab) } catch {}
    set({ activeTab: tab })
  },

  filters: {
    keyword: savedFilters.keyword ?? '直播运营',
    platforms: savedFilters.platforms ?? ['douyin', 'kuaishou', 'xiaohongshu'],
    sortBy: savedFilters.sortBy ?? 'recent',
    minLikes: savedFilters.minLikes ?? 0,
    commentActivity: savedFilters.commentActivity ?? 'any',
    fanProfile: savedFilters.fanProfile ?? '',
  },
  setFilter: (key, value) => set(s => {
    const next = { ...s.filters, [key]: value }
    saveFiltersToStorage(next)
    return { filters: next }
  }),
  togglePlatform: (p) => {
    const s = get()
    const platforms = s.filters.platforms.includes(p)
      ? s.filters.platforms.filter(x => x !== p)
      : [...s.filters.platforms, p]
    const next = { ...s.filters, platforms }
    saveFiltersToStorage(next)
    set({ filters: next })
    // Reload list so toggling a platform narrows/widens the visible videos
    // immediately, without requiring a page refresh.
    void get().loadExistingVideos()
  },
  videos: [],
  fetchedCount: 0,
  videoStats: { total: 0, commented: 0, pending: 0 },
  isFetching: false,
  fetchWarnings: [],
  lastFetchSummary: initialFetchSummary,
  loadVideoStats: async () => {
    try {
      const stats = await api.getVideoStats()
      set({ videoStats: stats })
    } catch (err) {
      console.error('Load video stats error:', err)
    }
  },
  loadExistingVideos: async () => {
    try {
      const { filters } = get()
      // On page load / refresh / platform-toggle, filter by selected platforms
      // (so toggling 抖音/快手 actually narrows the list). We DO NOT filter by
      // keyword — the keyword input is the crawl query, not a list filter.
      // Note: startFetch's post-crawl query intentionally skips the platform
      // filter so consecutive single-platform crawls accumulate on screen.
      const [videos, stats] = await Promise.all([
        api.getVideos({
          platforms: filters.platforms.join(','),
          minLikes: filters.minLikes,
          sortBy: filters.sortBy,
          excludePublished: true,
        }),
        api.getVideoStats().catch(() => null),
      ])
      const mapped: Video[] = videos.map(v => ({
        id: v.id,
        platform: v.platform as Platform,
        title: v.title,
        likes: v.likes,
        comments: v.comments,
        shares: v.shares,
        publishedAt: v.published_at,
        selected: false,
        publishedCount: v.published_count,
      }))
      set({
        videos: mapped,
        fetchedCount: mapped.length,
        ...(stats ? { videoStats: stats } : {}),
      })
    } catch (err) {
      console.error('Load existing videos error:', err)
    }
  },
  startFetch: async () => {
    const { filters } = get()
    const inProgress = `正在抓取「${filters.keyword}」...`
    // Do NOT persist the in-progress text. If HMR/refresh hits mid-crawl, isFetching
    // resets to false but we don't want the UI to show "✓ 正在抓取..." (misleading).
    // Only persist final/failed summaries.
    try { localStorage.removeItem(FETCH_SUMMARY_KEY) } catch {}
    set({ isFetching: true, fetchWarnings: [], lastFetchSummary: inProgress })
    let crawlCount = 0
    let newCount = 0
    try {
      // 1. Trigger real crawling via browser automation
      try {
        const report = await api.crawlVideos(filters.keyword, filters.platforms, filters.sortBy)
        crawlCount = report.count || 0
        newCount = report.newCount ?? 0
        if (report.warnings?.length) {
          set({ fetchWarnings: report.warnings })
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const failMsg = `抓取失败：${msg}`
        try { localStorage.setItem(FETCH_SUMMARY_KEY, failMsg) } catch {}
        set({ fetchWarnings: ['抓取失败：' + msg], lastFetchSummary: failMsg })
      }
      // 2. Query DB for results — show ALL crawled videos across ALL platforms,
      // not just the platforms selected for this crawl. Otherwise a single-
      // platform crawl (e.g. only Kuaishou) would hide previously crawled
      // Douyin videos. Platforms selection drives WHAT TO CRAWL, not display.
      const videos = await api.getVideos({
        minLikes: filters.minLikes,
        sortBy: filters.sortBy,
        excludePublished: true,
      })
      const mapped: Video[] = videos.map(v => ({
        id: v.id,
        platform: v.platform as Platform,
        title: v.title,
        likes: v.likes,
        comments: v.comments,
        shares: v.shares,
        publishedAt: v.published_at,
        selected: false,
        publishedCount: v.published_count,
      }))
      const dupCount = Math.max(0, crawlCount - newCount)
      const summary = `「${filters.keyword}」抓取完成：抓到 ${crawlCount} 条（新增 ${newCount}，重复 ${dupCount}），列表共 ${mapped.length} 条`
      try { localStorage.setItem(FETCH_SUMMARY_KEY, summary) } catch {}
      const stats = await api.getVideoStats().catch(() => null)
      set({
        videos: mapped,
        fetchedCount: mapped.length,
        isFetching: false,
        lastFetchSummary: summary,
        ...(stats ? { videoStats: stats } : {}),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const errMsg = `抓取出错：${msg}`
      try { localStorage.setItem(FETCH_SUMMARY_KEY, errMsg) } catch {}
      console.error('Fetch videos error:', err)
      set({ isFetching: false, lastFetchSummary: errMsg })
    }
  },
  toggleVideoSelect: (id) => set(s => ({
    videos: s.videos.map(v => v.id === id ? { ...v, selected: !v.selected } : v)
  })),
  selectAllVideos: () => set(s => {
    const allSelected = s.videos.every(v => v.selected)
    return { videos: s.videos.map(v => ({ ...v, selected: !allSelected })) }
  }),
  deleteSelectedVideos: async () => {
    const ids = get().videos.filter(v => v.selected).map(v => v.id)
    if (ids.length === 0) return
    try {
      await api.deleteVideos(ids)
    } catch (err) {
      console.error('Delete videos error:', err)
      return
    }
    const remaining = get().videos.filter(v => !v.selected)
    set({ videos: remaining, fetchedCount: remaining.length })
    const stats = await api.getVideoStats().catch(() => null)
    if (stats) set({ videoStats: stats })
  },

  commentStyle: 'resonance',
  setCommentStyle: (s) => set({ commentStyle: s }),
  commentNote: '',
  setCommentNote: (n) => set({ commentNote: n }),
  generatedComments: [],
  isGenerating: false,
  generationProgress: { current: 0, total: 0 },
  loadExistingComments: async () => {
    // Make sure videos are loaded first — without them we can't ask for comments
    let { videos } = get()
    if (videos.length === 0) {
      await get().loadExistingVideos()
      videos = get().videos
    }
    if (videos.length === 0) {
      set({ generatedComments: [] })
      return
    }
    try {
      // Load ALL un-queued comments for any video we know about — don't filter
      // by current selection, because a page refresh wipes selection state but
      // the user's previously generated comments are still in DB.
      const rows = await api.getExistingComments(videos.map(v => v.id))
      const comments: GeneratedComment[] = rows.map(r => ({
        id: r.id,
        videoId: r.video_id,
        videoTitle: r.video_title,
        content: r.content,
        style: r.style as CommentStyle,
      }))
      // Auto-select videos that have comments so "继续生成" works as expected
      const commentedIds = new Set(comments.map(c => c.videoId))
      const updatedVideos = commentedIds.size > 0
        ? videos.map(v => commentedIds.has(v.id) ? { ...v, selected: true } : v)
        : videos
      set({ generatedComments: comments, videos: updatedVideos })
    } catch (err) {
      console.error('Load existing comments error:', err)
    }
  },
  generateComments: async () => {
    const { videos, commentStyle, commentNote, generatedComments } = get()
    const selected = videos.filter(v => v.selected)
    if (selected.length === 0) return

    // Skip videos that already have a generated comment
    const existingVideoIds = new Set(generatedComments.map(c => c.videoId))
    const toGenerate = selected.filter(v => !existingVideoIds.has(v.id))

    set({ isGenerating: true, generationProgress: { current: 0, total: toGenerate.length } })

    for (let i = 0; i < toGenerate.length; i++) {
      const v = toGenerate[i]
      try {
        const results = await api.generateComments(
          [{ id: v.id, title: v.title, platform: v.platform }],
          commentStyle,
          commentNote || undefined,
        )
        if (results.length > 0) {
          const r = results[0]
          set(s => ({
            generatedComments: [...s.generatedComments, {
              id: r.id,
              videoId: r.videoId,
              videoTitle: r.videoTitle,
              content: r.content,
              style: commentStyle,
            }],
            generationProgress: { current: i + 1, total: toGenerate.length },
          }))
        }
      } catch (err) {
        console.error(`Generate comment for ${v.id} error:`, err)
      }
    }
    set({ isGenerating: false, generationProgress: { current: 0, total: 0 } })
  },
  regenerateComment: async (id) => {
    const { generatedComments, commentStyle, commentNote } = get()
    const comment = generatedComments.find(c => c.id === id)
    if (!comment) return

    const video = get().videos.find(v => v.id === comment.videoId)
    try {
      const result = await api.regenerateComment(
        id, comment.videoTitle, video?.platform || 'douyin', commentStyle, commentNote || undefined
      )
      set(s => ({
        generatedComments: s.generatedComments.map(c =>
          c.id === id ? { ...c, content: result.content } : c
        )
      }))
    } catch (err) {
      console.error('Regenerate error:', err)
    }
  },
  editComment: (id, content) => {
    api.updateComment(id, content).catch(console.error)
    set(s => ({
      generatedComments: s.generatedComments.map(c =>
        c.id === id ? { ...c, content } : c
      )
    }))
  },

  dispatchStatus: '',
  dispatchToPublishQueue: async () => {
    const { generatedComments, accounts, videos, publishTasks } = get()
    if (generatedComments.length === 0) {
      set({ dispatchStatus: '没有可发布的评论' })
      return
    }
    set({ dispatchStatus: '正在分配账号...' })
    try {
      // Count tasks already queued (pending/publishing) per account — they will
      // consume daily quota once executed, so dispatch shouldn't ignore them.
      const queuedByAccount = new Map<string, number>()
      for (const t of publishTasks) {
        if (t.status === 'pending' || t.status === 'publishing') {
          queuedByAccount.set(t.accountId, (queuedByAccount.get(t.accountId) || 0) + 1)
        }
      }

      // Per-account remaining slots = dailyLimit - todayPublished - alreadyQueued
      const remainingByAccount = new Map<string, number>()
      for (const a of accounts) {
        if (a.status !== 'online') continue
        const queued = queuedByAccount.get(a.id) || 0
        const remaining = a.dailyLimit - a.todayPublished - queued
        if (remaining > 0) remainingByAccount.set(a.id, remaining)
      }

      // Build a per-platform pool of accounts with available slots
      const poolByPlatform = new Map<string, Account[]>()
      for (const a of accounts) {
        if (!remainingByAccount.has(a.id)) continue
        const list = poolByPlatform.get(a.platform) || []
        list.push(a)
        poolByPlatform.set(a.platform, list)
      }

      let dispatched = 0
      const skipped: { reason: string; count: number }[] = []
      let skipNoAccount = 0
      let skipLimit = 0
      const usageIdx = new Map<string, number>()

      // Deduplicate by videoId: each video gets at most one comment, posted by
      // a single account. If a video has multiple generated comments (e.g. the
      // user regenerated), keep the first. Also skip any video that already has
      // an active task queued so re-running dispatch doesn't pile on duplicates.
      const alreadyQueuedVideoIds = new Set<string>()
      for (const t of publishTasks) {
        if (t.status === 'pending' || t.status === 'publishing' || t.status === 'completed') {
          alreadyQueuedVideoIds.add(t.videoId)
        }
      }
      const seenVideoIds = new Set<string>()
      const uniqueComments = generatedComments.filter(c => {
        if (alreadyQueuedVideoIds.has(c.videoId)) return false
        if (seenVideoIds.has(c.videoId)) return false
        seenVideoIds.add(c.videoId)
        return true
      })
      const duplicateSkipped = generatedComments.length - uniqueComments.length

      for (const comment of uniqueComments) {
        const video = videos.find(v => v.id === comment.videoId)
        if (!video) continue

        const pool = poolByPlatform.get(video.platform) || []
        if (pool.length === 0) {
          // Distinguish: no account at all, vs. all accounts at limit
          const anyOnline = accounts.some(a => a.platform === video.platform && a.status === 'online')
          if (anyOnline) skipLimit++; else skipNoAccount++
          continue
        }

        // Round-robin within the pool, but always pick an account that still has slots
        let account: Account | undefined
        for (let attempt = 0; attempt < pool.length; attempt++) {
          const idx = ((usageIdx.get(video.platform) || 0) + attempt) % pool.length
          const candidate = pool[idx]
          if ((remainingByAccount.get(candidate.id) || 0) > 0) {
            account = candidate
            usageIdx.set(video.platform, idx + 1)
            break
          }
        }

        if (!account) {
          skipLimit++
          continue
        }

        try {
          await api.createTask(account.id, video.id, comment.content)
        } catch (e) {
          // Server-side dedupe returned 409 for this video — already queued by
          // a parallel dispatch. Treat as a skip, not a hard failure.
          const msg = e instanceof Error ? e.message : String(e)
          if (/duplicate|409/i.test(msg)) continue
          throw e
        }
        remainingByAccount.set(account.id, (remainingByAccount.get(account.id) || 0) - 1)
        // If account is now full, remove from pool
        if ((remainingByAccount.get(account.id) || 0) <= 0) {
          const idx = pool.indexOf(account)
          if (idx >= 0) pool.splice(idx, 1)
          if (pool.length === 0) poolByPlatform.delete(video.platform)
        }
        dispatched++
      }
      await get().loadTasks()

      if (skipLimit > 0) skipped.push({ reason: '账号已到达每日上限', count: skipLimit })
      if (skipNoAccount > 0) skipped.push({ reason: '该平台无在线账号', count: skipNoAccount })
      if (duplicateSkipped > 0) skipped.push({ reason: '同一视频已分配/已发过', count: duplicateSkipped })
      let msg = `已加入发布队列 ${dispatched} 条`
      if (skipped.length > 0) {
        msg += '；跳过 ' + skipped.map(s => `${s.count} 条（${s.reason}）`).join('、')
      }
      set({ dispatchStatus: msg })
      setTimeout(() => set({ dispatchStatus: '' }), 6000)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ dispatchStatus: '加入失败：' + msg })
    }
  },

  accounts: [],
  publishTasks: [],
  dailyLimitPerAccount: savedSettings.dailyLimitPerAccount ?? 20,
  commentInterval: savedSettings.commentInterval ?? '3-8',
  rotationMode: savedSettings.rotationMode ?? 'sequential',
  isPublishing: false,
  setDailyLimit: (n) => { saveSettings({ dailyLimitPerAccount: n }); set({ dailyLimitPerAccount: n }) },
  setCommentInterval: (v) => { saveSettings({ commentInterval: v }); set({ commentInterval: v }) },
  setRotationMode: (v) => { saveSettings({ rotationMode: v }); set({ rotationMode: v }) },
  loadPublishStatus: async () => {
    try {
      const status = await api.getPublishStatus()
      const wasPublishing = get().isPublishing
      set({ isPublishing: status.enabled })
      // If backend says publishing but our local poll isn't running, kick it off
      if (status.enabled && !wasPublishing) {
        const poll = async () => {
          if (!get().isPublishing) return
          await get().loadTasks()
          await get().loadAccounts()
          setTimeout(poll, 5000)
        }
        setTimeout(poll, 2000)
      }
    } catch (err) {
      console.error('Load publish status error:', err)
    }
  },
  togglePublishing: async () => {
    const cur = get().isPublishing
    try {
      const intervalStr = get().commentInterval
      const [minStr, maxStr] = intervalStr.split('-')
      const intervalMinSec = parseInt(minStr) * 60
      const intervalMaxSec = parseInt(maxStr) * 60
      if (cur) {
        await api.stopPublish()
      } else {
        await api.startPublish({
          intervalMinSec,
          intervalMaxSec,
          dailyLimitPerAccount: get().dailyLimitPerAccount,
        })
      }
      set({ isPublishing: !cur })
      // Poll tasks periodically while publishing
      if (!cur) {
        const poll = async () => {
          if (!get().isPublishing) return
          await get().loadTasks()
          await get().loadAccounts()
          setTimeout(poll, 5000)
        }
        setTimeout(poll, 2000)
      }
    } catch (err) {
      console.error('Toggle publishing error:', err)
    }
  },
  cancelTask: async (id) => {
    try {
      await api.deleteTask(id)
      await get().loadTasks()
    } catch (err) {
      console.error('Cancel task error:', err)
    }
  },
  clearCompletedTasks: async () => {
    try {
      await api.clearTasks('completed')
      await get().loadTasks()
    } catch (err) {
      console.error('Clear completed tasks error:', err)
    }
  },
  clearErrorTasks: async () => {
    try {
      await api.clearTasks('error')
      // Also reload videos and comments — error tasks whose videos had no other
      // remaining tasks are now deleted from the videos table as well.
      await get().loadTasks()
      await get().loadExistingVideos()
      await get().loadExistingComments()
    } catch (err) {
      console.error('Clear error tasks error:', err)
    }
  },
  loadAccounts: async () => {
    try {
      const rows = await api.getAccounts()
      const accounts: Account[] = rows.map(a => ({
        id: a.id,
        name: a.name,
        platform: a.platform as Platform,
        avatar: a.avatar,
        status: a.status as 'online' | 'expired',
        dailyLimit: a.daily_limit,
        todayPublished: a.today_published,
      }))
      set({ accounts })
    } catch (err) {
      console.error('Load accounts error:', err)
    }
  },
  deleteAccount: async (id) => {
    if (!confirm('确定删除此账号吗？登录态和发布任务也会被一并清除。')) return
    try {
      await api.deleteAccount(id)
      await get().loadAccounts()
      await get().loadTasks()
    } catch (err) {
      console.error('Delete account error:', err)
      alert('删除失败：' + (err instanceof Error ? err.message : String(err)))
    }
  },
  relogin: async (accountId) => {
    set({ showAddModal: true, addingAccountStatus: 'opening_browser', addingAccountError: null })
    try {
      await api.startLogin(accountId)
      const poll = async (): Promise<void> => {
        const result = await api.getLoginStatus(accountId)
        if (result.status === 'success') {
          await get().loadAccounts()
          set({ addingAccountStatus: 'success' })
          setTimeout(() => set({ showAddModal: false, addingAccountStatus: '' }), 1200)
          return
        }
        if (result.status === 'failed') {
          set({ addingAccountStatus: 'failed', addingAccountError: result.error || '登录失败' })
          return
        }
        set({ addingAccountStatus: result.status })
        await new Promise(r => setTimeout(r, 1500))
        return poll()
      }
      await poll()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ addingAccountStatus: 'failed', addingAccountError: msg })
    }
  },

  showAddModal: false,
  setShowAddModal: (v) => set({ showAddModal: v, addingAccountStatus: '', addingAccountError: null }),
  addingAccountStatus: '',
  addingAccountError: null,
  addAccount: async (name, platform) => {
    set({ addingAccountStatus: 'creating', addingAccountError: null })
    try {
      const platformLabel = { douyin: '抖音', kuaishou: '快手', xiaohongshu: '小红书' }[platform]
      const avatar = name.charAt(0)
      const acc = await api.addAccount(name, platform, avatar)
      set({ addingAccountStatus: 'opening_browser' })

      await api.startLogin(acc.id)

      const poll = async (): Promise<void> => {
        const result = await api.getLoginStatus(acc.id)
        if (result.status === 'success') {
          await get().loadAccounts()
          set({ addingAccountStatus: 'success' })
          setTimeout(() => set({ showAddModal: false, addingAccountStatus: '' }), 1200)
          return
        }
        if (result.status === 'failed') {
          set({ addingAccountStatus: 'failed', addingAccountError: result.error || `登录${platformLabel}失败` })
          return
        }
        set({ addingAccountStatus: result.status })
        await new Promise(r => setTimeout(r, 1500))
        return poll()
      }
      await poll()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ addingAccountStatus: 'failed', addingAccountError: msg })
    }
  },

  loadTasks: async () => {
    try {
      const rows = await api.getTasks()
      const tasks: PublishTask[] = rows.map(t => ({
        id: t.id,
        accountId: t.account_id,
        videoId: t.video_id,
        videoTitle: t.video_title,
        commentContent: t.comment_content,
        scheduledTime: t.scheduled_time,
        status: t.status as PublishTask['status'],
      }))
      set({ publishTasks: tasks })
    } catch (err) {
      console.error('Load tasks error:', err)
    }
  },
}))
