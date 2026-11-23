import { db } from '@/lib/db'

export interface ConversationMemberInfo {
  id: string
  username: string
  nickname: string
  avatarColor: string
}

export interface ConversationSummary {
  id: string
  type: 'single' | 'group'
  name: string | null
  avatarColor: string
  members: ConversationMemberInfo[]
  lastMessage: {
    id: number
    content: string
    senderId: string
    senderNickname: string
    createdAt: string
  } | null
  unreadCount: number
  updatedAt: string
}

/** 查询某用户的会话列表（含最后一条消息、未读数） */
export async function listConversationsForUser(userId: string): Promise<ConversationSummary[]> {
  const memberships = await db.conversationMember.findMany({
    where: { userId },
    orderBy: { conversation: { updatedAt: 'desc' } },
    include: {
      conversation: {
        include: {
          members: {
            include: { user: true },
          },
          messages: {
            orderBy: { id: 'desc' },
            take: 1,
            include: { sender: true },
          },
        },
      },
    },
  })

  const result: ConversationSummary[] = []

  for (const m of memberships) {
    const conv = m.conversation
    const unreadCount = await db.message.count({
      where: {
        conversationId: conv.id,
        createdAt: { gt: m.lastReadAt },
        senderId: { not: userId },
      },
    })

    const last = conv.messages[0]
    result.push({
      id: conv.id,
      type: conv.type === 'group' ? 'group' : 'single',
      name: conv.name,
      avatarColor: conv.avatarColor,
      members: conv.members.map((mm) => ({
        id: mm.user.id,
        username: mm.user.username,
        nickname: mm.user.nickname,
        avatarColor: mm.user.avatarColor,
      })),
      lastMessage: last
        ? {
            id: last.id,
            content: last.content,
            senderId: last.senderId,
            senderNickname: last.sender.nickname,
            createdAt: last.createdAt.toISOString(),
          }
        : null,
      unreadCount,
      updatedAt: conv.updatedAt.toISOString(),
    })
  }

  // 按最后消息时间倒序
  result.sort((a, b) => {
    const ta = a.lastMessage ? new Date(a.lastMessage.createdAt).getTime() : new Date(a.updatedAt).getTime()
    const tb = b.lastMessage ? new Date(b.lastMessage.createdAt).getTime() : new Date(b.updatedAt).getTime()
    return tb - ta
  })

  return result
}

/** 查询用户的所有会话 id 及其相关用户 id（供 chat-service 同步房间/在线状态） */
export async function getUserOverview(userId: string): Promise<{
  conversationIds: string[]
  relatedUserIds: string[]
}> {
  const memberships = await db.conversationMember.findMany({
    where: { userId },
    include: {
      conversation: {
        include: { members: true },
      },
    },
  })

  const conversationIds: string[] = []
  const relatedUserIds = new Set<string>()

  for (const m of memberships) {
    conversationIds.push(m.conversationId)
    for (const mm of m.conversation.members) {
      if (mm.userId !== userId) relatedUserIds.add(mm.userId)
    }
  }

  return { conversationIds, relatedUserIds: Array.from(relatedUserIds) }
}

/** 找到两个用户的单聊会话（如无返回 null） */
export async function findSingleConversation(userA: string, userB: string) {
  const memberships = await db.conversationMember.findMany({
    where: { userId: userA, conversation: { type: 'single' } },
    include: { conversation: { include: { members: true } } },
  })
  return (
    memberships.find((m) => m.conversation.members.some((mm) => mm.userId === userB))?.conversation ?? null
  )
}

/** 创建两个用户的单聊会话（已存在则直接返回） */
export async function getOrCreateSingleConversation(userA: string, userB: string) {
  const existing = await findSingleConversation(userA, userB)
  if (existing) return existing

  const colors = ['#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316']
  const conv = await db.conversation.create({
    data: {
      type: 'single',
      avatarColor: colors[Math.floor(Math.random() * colors.length)],
      members: {
        create: [{ userId: userA }, { userId: userB }],
      },
    },
  })
  return conv
}

/** 获取会话内所有成员 userId */
export async function getConversationMemberIds(conversationId: string): Promise<string[]> {
  const members = await db.conversationMember.findMany({
    where: { conversationId },
    select: { userId: true },
  })
  return members.map((m) => m.userId)
}
