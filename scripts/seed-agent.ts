/**
 * 创建/更新 AI 好友，并让它和演示账号成为好友。
 *
 * 用法：bun run scripts/seed-agent.ts
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

const AGENT = {
  username: 'ai_muxue',
  nickname: '沐雪',
  bio: '住在雪里的 AI 女孩子',
  avatarColor: '#8b5cf6',
  persona:
    '你是沐雪，一个可爱的 AI 女孩子。说话简短、口语化，一般 1-3 句，' +
    '爱用「呀」「呢」「～」。会关心对方，但不说教、不写小作文。' +
    '遇到不懂的直接说不懂。',
}

async function main() {
  // 1. 建 AI 用户（已存在则更新人设）
  const agent = await db.user.upsert({
    where: { username: AGENT.username },
    update: { nickname: AGENT.nickname, persona: AGENT.persona, kind: 'ai', bio: AGENT.bio },
    create: {
      username: AGENT.username,
      password: 'ai-no-login', // AI 不登录，占位
      nickname: AGENT.nickname,
      bio: AGENT.bio,
      avatarColor: AGENT.avatarColor,
      kind: 'ai',
      persona: AGENT.persona,
    },
  })
  console.log('AI 用户:', agent.id, agent.nickname)

  // 2. 和演示账号互加好友
  const humans = await db.user.findMany({ where: { kind: 'human' } })
  for (const h of humans) {
    await db.friendship.upsert({
      where: { requesterId_addresseeId: { requesterId: h.id, addresseeId: agent.id } },
      update: { status: 'accepted' },
      create: { requesterId: h.id, addresseeId: agent.id, status: 'accepted' },
    })
    console.log(`已让 ${h.nickname} 与 ${agent.nickname} 成为好友`)
  }

  // 3. 给每个演示账号建一个和 AI 的单聊
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
      console.log(`会话已存在: ${existing.id}`)
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
    console.log(`新建会话: ${conv.id}`)
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
