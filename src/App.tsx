import { useStore } from './store'
import VideoFilterPage from './pages/VideoFilterPage'
import CommentGenPage from './pages/CommentGenPage'
import AccountPage from './pages/AccountPage'

const tabs = [
  { key: 'filter' as const, label: '视频筛选', icon: '🔍' },
  { key: 'comment' as const, label: '评论生成', icon: '💬' },
  { key: 'account' as const, label: '账号管理', icon: '👤' },
]

export default function App() {
  const activeTab = useStore(s => s.activeTab)
  const setActiveTab = useStore(s => s.setActiveTab)

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-6">
          <div className="flex items-center gap-8 h-14">
            {tabs.map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-2 h-full px-1 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === tab.key
                    ? 'border-primary text-primary'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                <span>{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </nav>
      <main className="max-w-7xl mx-auto">
        {activeTab === 'filter' && <VideoFilterPage />}
        {activeTab === 'comment' && <CommentGenPage />}
        {activeTab === 'account' && <AccountPage />}
      </main>
    </div>
  )
}
