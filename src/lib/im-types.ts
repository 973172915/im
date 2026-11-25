export interface SessionUser {
  id: string
  username: string
  nickname: string
  bio: string
  avatarColor: string
}

export interface ConversationMemberInfo {
  id: string
  username: string
  nickname: string
  avatarColor: string
}

export interface ChatMessage {
  id: number
  conversationId: string
  senderId: string
  senderNickname: string
  senderAvatarColor: string
  senderKind?: string
  content: string
  createdAt: string
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

export interface FriendInfo {
  id: string
  username: string
  nickname: string
  avatarColor: string
  bio: string
  conversationId: string | null
}

export interface FriendRequest {
  id: string
  createdAt: string
  requester: {
    id: string
    username: string
    nickname: string
    avatarColor: string
    bio: string
  }
}

export interface SearchUser {
  id: string
  username: string
  nickname: string
  avatarColor: string
  bio: string
  isFriend: boolean
  hasOutgoingRequest: boolean
  hasIncomingRequest: boolean
}

export interface TypingUser {
  userId: string
  nickname: string
  at: number
}
