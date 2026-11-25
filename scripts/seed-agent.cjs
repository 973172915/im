/* 临时脚本：创建 AI 好友并与演示账号互加 + 建单聊（JS 版，避免装 tsx） */
const { PrismaClient } = require('@prisma/client')

const db = new PrismaClient()

const AGENT = {
  username: 'ai_muxue',
  nickname: '沐雪',
  bio: '住在雪里的 AI 女孩子',
  avatarColor: '#8b5cf6',
  persona: '你是一个名为沐雪的可爱AI女孩子',
}

async function main() {
  const agent = await db.user.upsert({
    where: { username: AGENT.username },
    update: { nickname: AGENT.nickname, persona: AGENT.persona, kind: 'ai', bio: AGENT.bio },
    create: {
      username: AGENT.username,
      password: 'ai-no-login',
      nickname: AGENT.nickname,
      bio: AGENT.bio,
      avatarColor: AGENT.avatarColor,
      kind: 'ai',
      persona: AGENT.persona,
    },
  })
  console.log('AI 用户:', agent.id, agent.nickname)

  const humans = await db.user.findMany({ where: { kind: 'human' } })
  for (const h of humans) {
    await db.friendship.upsert({
      where: { requesterId_addresseeId: { requesterId: h.id, addresseeId: agent.id } },
      update: { status: 'accepted' },
      create: { requesterId: h.id, addresseeId: agent.id, status: 'accepted' },
    })
    console.log(`好友: ${h.nickname} <-> ${agent.nickname}`)
  }

  for (const h of humans) {
    const existing = await db.conversation.findFirst({
      where: {
        type: 'single',
        AND: [
          { members: { some: { userId: h.id } } },
          { members: { some: { userId: agent.id } } },
        ],
      },
    })
    if (existing) {
      console.log('会话已存在:', existing.id)
      continue
    }
    const conv = await db.conversation.create({
      data: {
        type: 'single',
        avatarColor: '#8b5cf6',
        createdById: h.id,
        members: { create: [{ userId: h.id }, { userId: agent.id }] },
      },
    })
    console.log('新建会话:', conv.id)
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
