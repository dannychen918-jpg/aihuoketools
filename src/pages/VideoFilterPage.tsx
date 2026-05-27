import { useEffect } from 'react'
import { useStore } from '../store'
import type { Platform } from '../types'

const platformLabels: Record<Platform, string> = {
  douyin: '抖音',
  kuaishou: '快手',
  xiaohongshu: '小红书',
}

const platformColors: Record<Platform, string> = {
  douyin: 'bg-rose-500',
  kuaishou: 'bg-orange-500',
  xiaohongshu: 'bg-red-500',
}

function formatNumber(n: number): string {
  if (n >= 10000) return (n / 10000).toFixed(1) + '万'
  return n.toLocaleString()
}

export default function VideoFilterPage() {
  const {
    filters, setFilter, togglePlatform,
    videos, fetchedCount, isFetching, startFetch,
    toggleVideoSelect, selectAllVideos, deleteSelectedVideos,
    fetchWarnings, lastFetchSummary,
    loadExistingVideos, videoStats,
  } = useStore()

  useEffect(() => {
    if (typeof loadExistingVideos === 'function') {
      loadExistingVideos()
    }
  }, [])

  const selectedCount = videos.filter(v => v.selected).length
  // Use server-side global stats — commented videos are filtered out of the
  // list itself, so counting from `videos` would always give 0.
  const commentedCount = videoStats.commented
  const pendingCount = videoStats.pending

  return (
    <div className="flex gap-0 min-h-[calc(100vh-56px)]">
      {/* Sidebar */}
      <div className="w-64 bg-white border-r border-gray-200 p-5 shrink-0">
        <h3 className="text-sm font-medium text-gray-500 mb-2">筛选条件</h3>

        <label className="block text-xs text-gray-500 mt-4 mb-1">关键词</label>
        <input
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary"
          value={filters.keyword}
          onChange={e => setFilter('keyword', e.target.value)}
        />

        <label className="block text-xs text-gray-500 mt-4 mb-2">平台</label>
        <div className="flex flex-wrap gap-2">
          {(['douyin', 'kuaishou', 'xiaohongshu'] as Platform[]).map(p => (
            <button
              key={p}
              onClick={() => togglePlatform(p)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                filters.platforms.includes(p)
                  ? 'bg-primary text-white'
                  : 'bg-gray-100 text-gray-500'
              }`}
            >
              {platformLabels[p]}
            </button>
          ))}
        </div>

        <label className="block text-xs text-gray-500 mt-4 mb-1">排序方式</label>
        <select
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          value={filters.sortBy}
          onChange={e => setFilter('sortBy', e.target.value as 'all' | 'recent' | 'likes' | 'comments')}
        >
          <option value="all">不限（综合·全部时间）</option>
          <option value="recent">最近发布（半年内）</option>
          <option value="likes">最多点赞</option>
          <option value="comments">最多评论</option>
        </select>

        <label className="block text-xs text-gray-500 mt-4 mb-1">评论活跃度</label>
        <select
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          value={filters.commentActivity}
          onChange={e => setFilter('commentActivity', e.target.value as 'any' | 'high' | 'medium' | 'low')}
        >
          <option value="any">不限</option>
          <option value="high">高（100条以上）</option>
          <option value="medium">中（50-100）</option>
          <option value="low">低（50以下）</option>
        </select>

        <label className="block text-xs text-gray-500 mt-4 mb-1">粉丝画像</label>
        <select
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          value={filters.fanProfile}
          onChange={e => setFilter('fanProfile', e.target.value)}
        >
          <option value="">不限</option>
          <option>直播运营从业者</option>
          <option>电商卖家</option>
          <option>自媒体人</option>
        </select>

        <label className="block text-xs text-gray-500 mt-4 mb-1">最低点赞数</label>
        <select
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          value={filters.minLikes}
          onChange={e => setFilter('minLikes', Number(e.target.value))}
        >
          <option value={0}>不限</option>
          <option value={100}>≥ 100</option>
          <option value={1000}>≥ 1000</option>
          <option value={5000}>≥ 5000</option>
          <option value={10000}>≥ 10000</option>
        </select>


        <button
          onClick={startFetch}
          disabled={isFetching}
          className="w-full mt-6 bg-primary hover:bg-primary-dark text-white rounded-lg py-2.5 text-sm font-medium disabled:opacity-50 transition-colors"
        >
          {isFetching ? '抓取中...' : '🔍 开始抓取'}
        </button>

        {fetchedCount > 0 && (
          <div className="mt-4 space-y-1 text-xs text-gray-500">
            <div className="flex justify-between"><span>已抓取</span><span className="font-medium text-gray-700">{fetchedCount} 条</span></div>
            <div className="flex justify-between"><span>已评论</span><span className="font-medium text-gray-700">{commentedCount} 条</span></div>
            <div className="flex justify-between"><span>待处理</span><span className="font-medium text-gray-700">{pendingCount} 条</span></div>
          </div>
        )}
      </div>

      {/* Main content */}
      <div className="flex-1 p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-4 flex-1 min-w-0">
            <div className="text-3xl font-bold text-primary">{fetchedCount}</div>
            <span className="text-sm text-gray-500 shrink-0">抓取总数</span>
            {(isFetching || lastFetchSummary) && (
              <span className={`text-xs px-3 py-1.5 rounded-full truncate ${
                isFetching
                  ? 'bg-blue-50 text-blue-600 border border-blue-200'
                  : lastFetchSummary.includes('失败') || lastFetchSummary.includes('出错')
                    ? 'bg-red-50 text-red-600 border border-red-200'
                    : 'bg-green-50 text-green-700 border border-green-200'
              }`}>
                {isFetching ? (
                  <><span className="inline-block w-2 h-2 bg-blue-500 rounded-full mr-1.5 animate-pulse" />{lastFetchSummary || '抓取中...'}</>
                ) : (
                  <>✓ {lastFetchSummary}</>
                )}
              </span>
            )}
          </div>
          {videos.length > 0 && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  if (selectedCount === 0) return
                  if (confirm(`确定删除选中的 ${selectedCount} 条视频吗？`)) deleteSelectedVideos()
                }}
                disabled={selectedCount === 0}
                className="px-4 py-2 border border-red-200 text-red-500 rounded-lg text-sm hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                🗑 删除{selectedCount > 0 ? ` (${selectedCount})` : ''}
              </button>
              <button
                onClick={selectAllVideos}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50"
              >
                {videos.every(v => v.selected) ? '取消全选' : '全选'}
                {selectedCount > 0 && ` (${selectedCount})`}
              </button>
            </div>
          )}
        </div>

        {fetchWarnings.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
            <div className="text-xs font-medium text-amber-700 mb-1">抓取提示</div>
            {fetchWarnings.map((w, i) => (
              <div key={i} className="text-xs text-amber-600">• {w}</div>
            ))}
          </div>
        )}

        {videos.length === 0 && !isFetching && (
          <div className="text-center text-gray-400 py-20 text-sm">
            设置筛选条件后，点击"开始抓取"获取目标视频
          </div>
        )}

        {isFetching && (
          <div className="text-center text-gray-400 py-20 text-sm">
            正在抓取视频...
          </div>
        )}

        <div className="space-y-3">
          {videos.map(video => (
            <div
              key={video.id}
              onClick={() => toggleVideoSelect(video.id)}
              className={`bg-white rounded-xl p-4 border cursor-pointer transition-all ${
                video.selected
                  ? 'border-primary bg-primary-light shadow-sm'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className={`px-2 py-0.5 rounded text-xs text-white ${platformColors[video.platform]}`}>
                      {platformLabels[video.platform]}
                    </span>
                    <span className="text-xs text-gray-400">{video.publishedAt}</span>
                  </div>
                  <h4 className="text-sm font-medium text-gray-800 leading-snug">{video.title}</h4>
                  <div className="flex items-center gap-4 mt-2 text-xs text-gray-400">
                    <span>♡ {formatNumber(video.likes)}</span>
                    <span>💬 {video.comments}</span>
                    <span>↗ {formatNumber(video.shares)}</span>
                  </div>
                </div>
                {video.selected && (
                  <span className="text-primary text-sm font-medium shrink-0">取消</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
