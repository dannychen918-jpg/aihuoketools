const API_BASE = 'http://localhost:3003/api'

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || 'Request failed')
  }
  return res.json()
}

export interface VideoRow {
  id: string
  platform: string
  title: string
  likes: number
  comments: number
  shares: number
  published_at: string
  keyword: string
  published_count?: number
}

export interface CommentRow {
  id: string
  videoId: string
  videoTitle: string
  content: string
  style: string
}

export interface AccountRow {
  id: string
  name: string
  platform: string
  avatar: string
  status: string
  daily_limit: number
  today_published: number
}

export interface TaskRow {
  id: string
  account_id: string
  video_id: string
  comment_content: string
  scheduled_time: string
  status: string
  video_title: string
  account_name: string
  account_avatar: string
  account_platform: string
}

export const api = {
  getVideos(params: { platforms?: string; keyword?: string; minLikes?: number; sortBy?: string; excludePublished?: boolean }) {
    const qs = new URLSearchParams()
    if (params.platforms) qs.set('platforms', params.platforms)
    if (params.keyword) qs.set('keyword', params.keyword)
    if (params.minLikes) qs.set('minLikes', String(params.minLikes))
    if (params.sortBy) qs.set('sortBy', params.sortBy)
    if (params.excludePublished) qs.set('excludePublished', '1')
    return request<VideoRow[]>(`/videos?${qs}`)
  },

  getVideoStats() {
    return request<{ total: number; commented: number; pending: number }>('/videos/stats')
  },

  purgeCommentedVideos() {
    return request<{ deleted: number }>('/videos/purge-commented', { method: 'POST' })
  },

  deleteVideos(ids: string[]) {
    return request<{ deleted: number }>('/videos/delete', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    })
  },

  generateComments(videos: { id: string; title: string; platform: string }[], style: string, note?: string) {
    return request<CommentRow[]>('/comments/generate', {
      method: 'POST',
      body: JSON.stringify({ videos, style, note }),
    })
  },

  getExistingComments(videoIds: string[]) {
    if (videoIds.length === 0) return Promise.resolve([])
    return request<Array<{ id: string; video_id: string; video_title: string; content: string; style: string }>>(
      `/comments?videoIds=${videoIds.join(',')}`
    )
  },

  regenerateComment(commentId: string, videoTitle: string, platform: string, style: string, note?: string) {
    return request<{ id: string; content: string }>('/comments/regenerate', {
      method: 'POST',
      body: JSON.stringify({ commentId, videoTitle, platform, style, note }),
    })
  },

  updateComment(id: string, content: string) {
    return request(`/comments/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    })
  },

  getAccounts() {
    return request<AccountRow[]>('/accounts')
  },

  addAccount(name: string, platform: string, avatar: string) {
    return request<AccountRow>('/accounts', {
      method: 'POST',
      body: JSON.stringify({ name, platform, avatar }),
    })
  },

  deleteAccount(id: string) {
    return request<{ success: boolean }>(`/accounts/${id}`, { method: 'DELETE' })
  },

  getTasks() {
    return request<TaskRow[]>('/tasks')
  },

  createTask(accountId: string, videoId: string, commentContent: string) {
    return request<{ id: string }>('/tasks', {
      method: 'POST',
      body: JSON.stringify({ accountId, videoId, commentContent }),
    })
  },

  updateTaskStatus(id: string, status: string) {
    return request(`/tasks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    })
  },

  deleteTask(id: string) {
    return request<{ deleted: number }>(`/tasks/${id}`, { method: 'DELETE' })
  },

  clearTasks(status?: string) {
    const qs = status ? `?status=${status}` : ''
    return request<{ deleted: number }>(`/tasks${qs}`, { method: 'DELETE' })
  },

  startLogin(accountId: string) {
    return request<{ sessionId: string }>(`/accounts/${accountId}/login`, { method: 'POST' })
  },

  getLoginStatus(accountId: string) {
    return request<{ status: string; qrcodeDataUrl?: string; error?: string }>(`/accounts/${accountId}/login/status`)
  },

  cancelLogin(accountId: string) {
    return request(`/accounts/${accountId}/login/cancel`, { method: 'POST' })
  },

  getPublishStatus() {
    return request<{ enabled: boolean; workerRunning: boolean; intervalMinSec: number; intervalMaxSec: number }>('/publish/status')
  },

  startPublish(opts: { intervalMinSec?: number; intervalMaxSec?: number; dailyLimitPerAccount?: number }) {
    return request<{ enabled: boolean }>('/publish/start', {
      method: 'POST',
      body: JSON.stringify(opts),
    })
  },

  stopPublish() {
    return request<{ enabled: boolean }>('/publish/stop', { method: 'POST' })
  },

  crawlVideos(keyword: string, platforms: string[], sortBy?: string) {
    return request<{ count: number; newCount?: number; updatedCount?: number; videos: VideoRow[]; warnings?: string[]; needCaptcha?: boolean }>('/crawl', {
      method: 'POST',
      body: JSON.stringify({ keyword, platforms, sortBy }),
    })
  },
}
