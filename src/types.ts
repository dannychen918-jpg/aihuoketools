export type Platform = 'douyin' | 'kuaishou' | 'xiaohongshu'

export interface Video {
  id: string
  platform: Platform
  title: string
  likes: number
  comments: number
  shares: number
  publishedAt: string
  selected: boolean
  publishedCount?: number
}

export type CommentStyle = 'resonance' | 'curiosity' | 'experience'

export interface GeneratedComment {
  id: string
  videoId: string
  videoTitle: string
  content: string
  style: CommentStyle
}

export type AccountStatus = 'online' | 'expired'
export type PublishStatus = 'publishing' | 'pending' | 'completed' | 'error'

export interface Account {
  id: string
  name: string
  platform: Platform
  avatar: string
  status: AccountStatus
  dailyLimit: number
  todayPublished: number
}

export interface PublishTask {
  id: string
  accountId: string
  videoId: string
  videoTitle: string
  commentContent: string
  scheduledTime: string
  status: PublishStatus
}
