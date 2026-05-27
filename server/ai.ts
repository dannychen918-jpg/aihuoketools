const stylePrompts: Record<string, string> = {
  resonance: '以同行身份发表评论，表达共鸣和理解，让视频作者和观众感觉你是圈内人。',
  curiosity: '以好奇提问的方式发表评论，提出与视频内容相关的问题，引发互动和讨论。',
  experience: '以分享个人经验的方式发表评论，分享相关的心得体会，展示专业性。',
}

export async function generateAIComment(
  videoTitle: string,
  platform: string,
  style: string,
  note?: string
): Promise<string> {
  const styleGuide = stylePrompts[style] || stylePrompts.resonance

  const prompt = `你是一个社交媒体评论生成专家。请为以下短视频生成一条自然的引流评论。

视频标题：${videoTitle}
平台：${platform}
评论风格：${styleGuide}
${note ? `额外要求：${note}` : ''}

要求：
1. 评论要自然真实，像真人发的，不能像广告
2. 评论长度控制在20-50个字
3. 要有引导性，让人想点进你的主页看看
4. 不要带任何链接、@、#话题标签
5. 根据平台特点调整语气（抖音偏活泼、快手偏接地气、小红书偏分享感）

直接输出评论内容，不要任何解释。`

  const baseUrl = process.env.AI_BASE_URL || 'https://zenmux.ai/api/anthropic'
  const apiKey = process.env.AI_API_KEY || ''

  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    console.error(`AI API error: ${res.status}`, err)
    console.error(`URL: ${baseUrl}/v1/messages`)
    throw new Error(`AI API error: ${res.status} ${err}`)
  }

  const data = await res.json()
  const block = data.content?.[0]
  if (block?.type === 'text') {
    return block.text.trim()
  }
  return '评论生成失败，请重试'
}
