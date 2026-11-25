/**
 * 让人类用户与默认 AI 好友成为好友，并保证存在一个单聊会话。
 *
 * 用途：新注册用户也应当开箱即有一个 AI 好友（否则聊天列表是空的）。
 */
import { db } from '@/lib/db'

export async function ensureAiFriend(userId: string) {
  // 取第一个 AI 用户作为默认好友
  const agent = await db.user.findFirst({
    where: { kind: 'ai' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, nickname: true },
  })
  if (!agent) return null

  // 双向好友：一条 accepted 记录即可（查询按两边 OR）
  await db.friendship.upsert({
    where: {
      requesterId_addresseeId: { requesterId: agent.id, addresseeId: userId },
    },
    update: { status: 'accepted' },
    create: { requesterId: agent.id, addresseeId: userId, status: 'accepted' },
  })

  // 单聊会话（已存在则复用）
  const existing = await db.conversation.findFirst({
    where: {
      type: 'single',
      AND: [
        { members: { some: { userId } } },
        { members: { some: { userId: agent.id } } },
      ],
    },
    select: { id: true },
  })
  if (existing) return { agent, conversationId: existing.id }

  const created = await db.conversation.create({
    data: {
      type: 'single',
      members: { create: [{ userId }, { userId: agent.id }] },
    },
    select: { id: true },
  })

  return { agent, conversationId: created.id }
}
