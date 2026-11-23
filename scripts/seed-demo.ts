/**
 * 重置数据库并写入干净的演示数据：
 * - alice_demo（昵称：灵儿）/ bob_demo（昵称：小智）互为好友，有一段简短欢迎对话
 */
import { PrismaClient } from '@prisma/client'
import { randomBytes, scryptSync } from 'crypto'

const db = new PrismaClient()

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

async function main() {
  // 清空所有业务表
  await db.message.deleteMany()
  await db.conversationMember.deleteMany()
  await db.conversation.deleteMany()
  await db.friendship.deleteMany()
  await db.session.deleteMany()
  await db.user.deleteMany()

  // 创建演示用户
  const alice = await db.user.create({
    data: {
      username: 'alice_demo',
      password: hashPassword('123456'),
      nickname: '灵儿',
      bio: '爱读书、爱旅行',
      avatarColor: '#10b981',
    },
  })
  const bob = await db.user.create({
    data: {
      username: 'bob_demo',
      password: hashPassword('123456'),
      nickname: '小智',
      bio: '科技爱好者',
      avatarColor: '#f59e0b',
    },
  })

  // 好友关系
  await db.friendship.create({
    data: { requesterId: alice.id, addresseeId: bob.id, status: 'accepted' },
  })

  // 单聊会话
  const conv = await db.conversation.create({
    data: {
      type: 'single',
      avatarColor: '#10b981',
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  })

  // 欢迎消息
  const m1 = await db.message.create({
    data: { conversationId: conv.id, senderId: alice.id, content: '你好呀，欢迎使用灵犀 IM！' },
  })
  const m2 = await db.message.create({
    data: { conversationId: conv.id, senderId: bob.id, content: '你好！试试实时消息、正在输入提示和群聊功能吧' },
  })

  // 会话更新时间
  await db.conversation.update({ where: { id: conv.id }, data: { updatedAt: m2.createdAt } })

  console.log('演示数据已重置：')
  console.log('  alice_demo / 123456（昵称：灵儿）')
  console.log('  bob_demo   / 123456（昵称：小智）')
  console.log(`  会话 ${conv.id}，消息 ${m1.id}-${m2.id}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => void db.$disconnect())
