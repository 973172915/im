/**
 * 极简 token 估算（不引入 tokenizer 依赖）。
 *
 * 依据：Qwen 系列对中文基本 1 字 ≈ 1 token；英文约 4 字符 ≈ 1.3 token。
 * 用于上下文预算控制，宁可高估一点。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // 常用汉字
      (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
      (code >= 0x3040 && code <= 0x30ff) || // 假名
      (code >= 0xac00 && code <= 0xd7af) // 韩文
    ) {
      cjk++
    } else {
      other++
    }
  }
  return Math.ceil(cjk + other * 0.34)
}

/** 一组消息的总 token */
export function estimateMessagesTokens(messages: { content: string }[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
}
