import { useEffect, useState } from 'react'
import { useStore } from '../store'
import type { CommentStyle, Platform } from '../types'

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

const styleLabels: Record<CommentStyle, string> = {
  resonance: '业内共鸣',
  curiosity: '提问好奇',
  experience: '经验分享',
}

function formatNumber(n: number): string {
  if (n >= 10000) return (n / 10000).toFixed(1) + '万'
  return n.toLocaleString()
}

export default function CommentGenPage() {
  const {
    videos, commentStyle, setCommentStyle,
    commentNote, setCommentNote,
    generatedComments, generateComments, isGenerating, generationProgress,
    regenerateComment, editComment,
    selectAllVideos, toggleVideoSelect, setActiveTab,
    dispatchToPublishQueue, dispatchStatus,
    loadAccounts, accounts,
    loadExistingComments,
  } = useStore()

  useEffect(() => {
    if (accounts.length === 0 && typeof loadAccounts === 'function') loadAccounts()
    // Load any previously generated comments for currently selected videos
    if (typeof loadExistingComments === 'function') loadExistingComments()
  }, [])

  const selectedVideos = videos.filter(v => v.selected)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

  const handleEdit = (id: string, content: string) => {
    setEditingId(id)
    setEditValue(content)
  }

  const handleSaveEdit = (id: string) => {
    editComment(id, editValue)
    setEditingId(null)
  }

  const handleCopy = async (text: string) => {
    await navigator.clipboard.writeText(text)
  }

  return (
    <div className="flex gap-0 min-h-[calc(100vh-56px)]">
      {/* Left - video selector */}
      <div className="w-56 bg-white border-r border-gray-200 p-4 shrink-0">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-gray-700">选择视频</h3>
          <button
            onClick={selectAllVideos}
            className="text-xs text-primary hover:text-primary-dark"
          >
            全选
          </button>
        </div>

        {videos.length === 0 && (
          <div className="text-xs text-gray-400 py-8 text-center">
            请先到
            <button onClick={() => setActiveTab('filter')} className="text-primary mx-1">视频筛选</button>
            页面抓取视频
          </div>
        )}

        <div className="space-y-2">
          {videos.map(video => (
            <div
              key={video.id}
              onClick={() => toggleVideoSelect(video.id)}
              className={`p-2.5 rounded-lg border cursor-pointer transition-colors text-xs ${
                video.selected
                  ? 'border-primary bg-orange-50'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <span className={`px-1.5 py-0.5 rounded text-[10px] text-white ${platformColors[video.platform]}`}>
                  {platformLabels[video.platform]}
                </span>
              </div>
              <p className="text-gray-700 line-clamp-2 leading-relaxed">{video.title}</p>
              <div className="flex items-center gap-2 mt-1 text-gray-400 text-[10px]">
                <span>♡ {formatNumber(video.likes)}</span>
                <span>💬 {video.comments}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Right - comment generation */}
      <div className="flex-1 p-5">
        {/* Style config */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 mb-5">
          <div className="flex items-start gap-8">
            <div className="flex-1">
              <p className="text-sm text-gray-600 mb-3">
                每个视频对应生成一个评论。<br />
                要根据平台、和评论风格和备注要求生成
              </p>
              <div className="flex items-center gap-3 mb-4">
                <span className="text-xs text-gray-500">评论风格</span>
                {(Object.entries(styleLabels) as [CommentStyle, string][]).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setCommentStyle(key)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      commentStyle === key
                        ? 'bg-primary text-white'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div>
                <label className="text-xs text-gray-500">备注要求</label>
                <textarea
                  className="w-full mt-1 border border-gray-300 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:border-primary"
                  rows={2}
                  placeholder="可选：补充特殊要求..."
                  value={commentNote}
                  onChange={e => setCommentNote(e.target.value)}
                />
              </div>
            </div>
          </div>
          <div className="flex justify-end mt-3">
            <button
              onClick={generateComments}
              disabled={selectedVideos.length === 0 || isGenerating}
              className="bg-primary hover:bg-primary-dark text-white px-5 py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
            >
              {isGenerating
                ? `⏳ 生成中 ${generationProgress.current}/${generationProgress.total}...`
                : `🔄 ${generatedComments.length > 0 ? '继续生成' : 'AI 生成评论'}`}
              {!isGenerating && selectedVideos.length > 0 && ` (剩余 ${selectedVideos.length - generatedComments.filter(c => selectedVideos.some(v => v.id === c.videoId)).length} 条)`}
            </button>
          </div>
        </div>

        {/* Generated comments */}
        {generatedComments.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-gray-700">AI 生成评论</h3>
              <div className="flex items-center gap-3">
                {dispatchStatus && (
                  <span className="text-xs text-gray-500">{dispatchStatus}</span>
                )}
                <button
                  onClick={dispatchToPublishQueue}
                  className="px-4 py-2 bg-green-500 hover:bg-green-600 text-white rounded-lg text-sm font-medium"
                >
                  ➤ 加入发布队列 ({generatedComments.length}条)
                </button>
              </div>
            </div>
            <div className="space-y-3">
              {generatedComments.map(c => (
                <div key={c.id} className="bg-white rounded-xl border border-gray-200 p-4">
                  {editingId === c.id ? (
                    <div>
                      <textarea
                        className="w-full border border-primary rounded-lg px-3 py-2 text-sm resize-none focus:outline-none"
                        rows={2}
                        value={editValue}
                        onChange={e => setEditValue(e.target.value)}
                      />
                      <div className="flex justify-end gap-2 mt-2">
                        <button
                          onClick={() => setEditingId(null)}
                          className="px-3 py-1 text-xs text-gray-500 hover:text-gray-700"
                        >
                          取消
                        </button>
                        <button
                          onClick={() => handleSaveEdit(c.id)}
                          className="px-3 py-1 bg-primary text-white rounded text-xs"
                        >
                          保存
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="text-sm text-gray-800 leading-relaxed">{c.content}</p>
                      <div className="flex items-center justify-between mt-3">
                        <span className="text-xs text-gray-400">
                          对应视频：{c.videoTitle.slice(0, 20)}...
                        </span>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleCopy(c.content)}
                            className="px-3 py-1 border border-gray-300 rounded text-xs text-gray-600 hover:bg-gray-50"
                          >
                            📋 复制
                          </button>
                          <button
                            onClick={() => handleEdit(c.id, c.content)}
                            className="px-3 py-1 border border-gray-300 rounded text-xs text-gray-600 hover:bg-gray-50"
                          >
                            ✏️ 编辑
                          </button>
                          <button
                            onClick={() => regenerateComment(c.id)}
                            className="px-3 py-1 bg-primary text-white rounded text-xs hover:bg-primary-dark"
                          >
                            🔄 重新生成
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {generatedComments.length === 0 && selectedVideos.length === 0 && (
          <div className="text-center text-gray-400 py-16 text-sm">
            请先选择视频，然后点击"AI 生成评论"
          </div>
        )}
      </div>
    </div>
  )
}
