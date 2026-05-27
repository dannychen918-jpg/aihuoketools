import { useEffect, useState } from 'react'
import { useStore } from '../store'
import type { Platform, PublishStatus } from '../types'

const platformLabels: Record<Platform, string> = {
  douyin: '抖音',
  kuaishou: '快手',
  xiaohongshu: '小红书',
}

const platformColors: Record<Platform, string> = {
  douyin: 'text-rose-500',
  kuaishou: 'text-orange-500',
  xiaohongshu: 'text-red-500',
}

const avatarColors = ['bg-orange-500', 'bg-green-500', 'bg-blue-500', 'bg-purple-500']

const statusConfig: Record<PublishStatus, { label: string; color: string }> = {
  publishing: { label: '发布中', color: 'bg-green-100 text-green-700' },
  pending: { label: '待发布', color: 'bg-yellow-100 text-yellow-700' },
  completed: { label: '已完成', color: 'bg-gray-100 text-gray-500' },
  error: { label: '发布失败', color: 'bg-red-100 text-red-600' },
}

export default function AccountPage() {
  const {
    accounts, publishTasks,
    dailyLimitPerAccount, commentInterval, rotationMode,
    isPublishing,
    setDailyLimit, setCommentInterval, setRotationMode,
    togglePublishing, cancelTask, clearCompletedTasks, clearErrorTasks,
    loadAccounts, loadTasks, loadPublishStatus,
    showAddModal, setShowAddModal, addAccount,
    addingAccountStatus, addingAccountError,
    deleteAccount, relogin,
  } = useStore()

  const [newName, setNewName] = useState('')
  const [newPlatform, setNewPlatform] = useState<Platform>('douyin')

  useEffect(() => {
    loadAccounts()
    loadTasks()
    loadPublishStatus()
    // Auto-refresh tasks every 5s so we see publish progress
    const intv = setInterval(() => {
      loadTasks()
      loadAccounts()
      loadPublishStatus()
    }, 5000)
    return () => clearInterval(intv)
  }, [])

  const onlineCount = accounts.filter(a => a.status === 'online').length
  const todayPublished = accounts.reduce((sum, a) => sum + a.todayPublished, 0)
  const totalRemaining = accounts.reduce((sum, a) => sum + (a.dailyLimit - a.todayPublished), 0)

  return (
    <div className="flex gap-0 min-h-[calc(100vh-56px)]">
      {/* Left - account list */}
      <div className="w-64 bg-white border-r border-gray-200 p-4 shrink-0">
        <h3 className="text-sm font-medium text-gray-700 mb-3">我的账号</h3>

        <div className="space-y-2 mb-4">
          {accounts.map((acc, i) => (
            <div
              key={acc.id}
              className="group p-3 rounded-xl border border-gray-200 hover:border-gray-300 transition-colors"
            >
              <div className="flex items-center gap-2.5">
                <div className={`w-8 h-8 rounded-full ${avatarColors[i % avatarColors.length]} text-white flex items-center justify-center text-sm font-medium`}>
                  {acc.avatar}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium text-gray-800 truncate">{acc.name}</span>
                    <span className={`w-2 h-2 rounded-full ${acc.status === 'online' ? 'bg-green-500' : 'bg-gray-300'}`} />
                  </div>
                  <div className="flex items-center gap-2 text-[10px] mt-0.5">
                    <span className={platformColors[acc.platform]}>{platformLabels[acc.platform]}</span>
                    {acc.status === 'online' ? (
                      <span className="text-gray-400">
                        今日已发 {acc.todayPublished} 条 剩余 {acc.dailyLimit - acc.todayPublished} 条
                      </span>
                    ) : (
                      <span className="text-red-400">登录已过期</span>
                    )}
                  </div>
                </div>
                <div className="flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {acc.status !== 'online' && (
                    <button
                      onClick={() => relogin(acc.id)}
                      className="text-[10px] text-primary hover:text-primary-dark px-1.5 py-0.5 border border-orange-200 rounded"
                      title="重新登录"
                    >
                      重登
                    </button>
                  )}
                  <button
                    onClick={() => deleteAccount(acc.id)}
                    className="text-[10px] text-red-500 hover:text-red-600 px-1.5 py-0.5 border border-red-200 rounded"
                    title="删除账号"
                  >
                    删除
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

        <button
          onClick={() => setShowAddModal(true)}
          className="w-full py-2.5 border-2 border-dashed border-gray-300 rounded-xl text-sm text-gray-500 hover:border-gray-400 hover:text-gray-600 transition-colors"
        >
          + 添加账号
        </button>

        <div className="mt-5 pt-4 border-t border-gray-200">
          <h4 className="text-xs font-medium text-gray-500 mb-3">发布节奏控制</h4>

          <label className="block text-[11px] text-gray-400 mb-1">每账号每日上限</label>
          <select
            className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs mb-2.5"
            value={dailyLimitPerAccount}
            onChange={e => setDailyLimit(Number(e.target.value))}
          >
            <option value={10}>10 条</option>
            <option value={15}>15 条</option>
            <option value={20}>20 条</option>
          </select>

          <label className="block text-[11px] text-gray-400 mb-1">评论间隔</label>
          <select
            className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs mb-2.5"
            value={commentInterval}
            onChange={e => setCommentInterval(e.target.value)}
          >
            <option value="1-3">1~3 分钟</option>
            <option value="3-8">3~8 分钟</option>
            <option value="5-15">5~15 分钟</option>
          </select>

          <label className="block text-[11px] text-gray-400 mb-1">账号轮换方式</label>
          <select
            className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs"
            value={rotationMode}
            onChange={e => setRotationMode(e.target.value)}
          >
            <option value="sequential">顺序轮换</option>
            <option value="random">随机轮换</option>
          </select>
        </div>
      </div>

      {/* Right - publish queue */}
      <div className="flex-1 p-5">
        {/* Stats */}
        <div className="grid grid-cols-4 gap-4 mb-5">
          {[
            { label: '账号总数', value: accounts.length },
            { label: '今日已发', value: todayPublished },
            { label: '剩余配额', value: totalRemaining },
            { label: '账号在线', value: onlineCount },
          ].map(stat => (
            <div key={stat.label} className="bg-white rounded-xl border border-gray-200 p-4 text-center">
              <div className="text-2xl font-bold text-gray-800">{stat.value}</div>
              <div className="text-xs text-gray-400 mt-1">{stat.label}</div>
            </div>
          ))}
        </div>

        {/* Controls */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-gray-700">发布队列</h3>
          <div className="flex items-center gap-3">
            {(() => {
              const errorCount = publishTasks.filter(t => t.status === 'error').length
              return (
                <button
                  onClick={() => {
                    if (errorCount === 0) return
                    if (confirm(`确定清除 ${errorCount} 条发布失败的任务吗？\n清除后，对应评论会重新出现在「评论生成」页，可以再次加入发布队列。`)) clearErrorTasks()
                  }}
                  disabled={errorCount === 0}
                  className="px-4 py-2 border border-orange-200 text-orange-600 rounded-lg text-sm hover:bg-orange-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  🔄 发布失败一键清除{errorCount > 0 ? ` (${errorCount})` : ''}
                </button>
              )
            })()}
            {(() => {
              const completedCount = publishTasks.filter(t => t.status === 'completed').length
              return (
                <button
                  onClick={() => {
                    if (completedCount === 0) return
                    if (confirm(`确定删除 ${completedCount} 条已完成的任务吗？`)) clearCompletedTasks()
                  }}
                  disabled={completedCount === 0}
                  className="px-4 py-2 border border-red-200 text-red-500 rounded-lg text-sm hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  🗑 全部删除已完成{completedCount > 0 ? ` (${completedCount})` : ''}
                </button>
              )
            })()}
            <button
              onClick={() => togglePublishing()}
              className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
            >
              暂停全部
            </button>
            <button
              onClick={() => togglePublishing()}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                isPublishing
                  ? 'bg-gray-500 text-white'
                  : 'bg-primary text-white hover:bg-primary-dark'
              }`}
            >
              {isPublishing ? '⏸ 暂停执行' : '▶ 开始执行'}
            </button>
          </div>
        </div>

        {/* Task table */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-xs text-gray-500">
                <th className="text-left py-3 px-4 font-medium">账号</th>
                <th className="text-left py-3 px-4 font-medium">目标视频</th>
                <th className="text-left py-3 px-4 font-medium">评论内容</th>
                <th className="text-left py-3 px-4 font-medium">计划时间</th>
                <th className="text-left py-3 px-4 font-medium">状态</th>
                <th className="text-left py-3 px-4 font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {publishTasks.map(task => {
                const account = accounts.find(a => a.id === task.accountId)
                const status = statusConfig[task.status]
                const accIndex = accounts.findIndex(a => a.id === task.accountId)
                return (
                  <tr key={task.id} className="hover:bg-gray-50">
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <div className={`w-6 h-6 rounded-full ${avatarColors[accIndex % avatarColors.length]} text-white flex items-center justify-center text-xs`}>
                          {account?.avatar}
                        </div>
                        <span className="text-xs text-gray-700">{account?.name.slice(0, 4)}</span>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-xs text-gray-500 max-w-[120px] truncate">
                      {task.videoTitle}
                    </td>
                    <td className="py-3 px-4 text-xs text-gray-700 max-w-[200px] truncate">
                      {task.commentContent}
                    </td>
                    <td className="py-3 px-4 text-xs text-gray-400">{task.scheduledTime}</td>
                    <td className="py-3 px-4">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${status.color}`}>
                        {status.label}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <button
                        onClick={() => {
                          if (confirm('删除此任务？')) cancelTask(task.id)
                        }}
                        className="text-xs text-red-500 hover:text-red-600"
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {showAddModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-6 w-[420px] shadow-xl">
            <h3 className="text-lg font-semibold text-gray-800 mb-1">添加账号</h3>
            <p className="text-xs text-gray-500 mb-5">填写账号信息后，将自动打开浏览器窗口，请在窗口中扫码或输入账号密码登录</p>

            {addingAccountStatus === '' && (
              <>
                <label className="block text-xs text-gray-500 mb-1">账号备注名</label>
                <input
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:border-primary"
                  placeholder="例如：张老板直播运营"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                />

                <label className="block text-xs text-gray-500 mb-2">选择平台</label>
                <div className="grid grid-cols-3 gap-2 mb-5">
                  {(['douyin', 'kuaishou', 'xiaohongshu'] as Platform[]).map(p => (
                    <button
                      key={p}
                      onClick={() => setNewPlatform(p)}
                      className={`py-2.5 rounded-lg text-sm font-medium transition-colors ${
                        newPlatform === p
                          ? 'bg-primary text-white'
                          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                      }`}
                    >
                      {platformLabels[p]}
                    </button>
                  ))}
                </div>

                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setShowAddModal(false)}
                    className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
                  >
                    取消
                  </button>
                  <button
                    onClick={() => newName.trim() && addAccount(newName.trim(), newPlatform)}
                    disabled={!newName.trim()}
                    className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-dark disabled:opacity-50"
                  >
                    打开登录窗口
                  </button>
                </div>
              </>
            )}

            {addingAccountStatus && addingAccountStatus !== 'success' && addingAccountStatus !== 'failed' && (
              <div className="py-8 text-center">
                <div className="inline-block w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin mb-3" />
                <p className="text-sm text-gray-700 mb-1">
                  {addingAccountStatus === 'creating' && '正在创建账号...'}
                  {addingAccountStatus === 'opening_browser' && '正在打开浏览器窗口...'}
                  {addingAccountStatus === 'opening' && '正在打开浏览器窗口...'}
                  {addingAccountStatus === 'waiting_user' && '请在弹出的浏览器窗口中登录'}
                </p>
                <p className="text-xs text-gray-400">登录成功后，窗口将自动关闭</p>
              </div>
            )}

            {addingAccountStatus === 'success' && (
              <div className="py-8 text-center">
                <div className="inline-block w-12 h-12 rounded-full bg-green-100 text-green-600 text-2xl flex items-center justify-center mb-3">✓</div>
                <p className="text-sm text-gray-700">登录成功！</p>
              </div>
            )}

            {addingAccountStatus === 'failed' && (
              <div className="py-6 text-center">
                <div className="inline-block w-12 h-12 rounded-full bg-red-100 text-red-600 text-2xl flex items-center justify-center mb-3">✕</div>
                <p className="text-sm text-red-600 mb-3">{addingAccountError || '登录失败'}</p>
                <button
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
                >
                  关闭
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
