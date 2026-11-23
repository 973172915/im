'use client'

import { cn } from '@/lib/utils'

interface IMAvatarProps {
  nickname: string
  color: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
  online?: boolean | null // null = 不显示状态点
  className?: string
}

const SIZES = {
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-12 w-12 text-base',
  xl: 'h-16 w-16 text-xl',
}

const DOT_SIZES = {
  sm: 'h-2 w-2',
  md: 'h-2.5 w-2.5',
  lg: 'h-3 w-3',
  xl: 'h-3.5 w-3.5',
}

export function IMAvatar({ nickname, color, size = 'md', online = null, className }: IMAvatarProps) {
  const initial = (nickname || '?').trim().charAt(0).toUpperCase()

  return (
    <div className={cn('relative inline-flex shrink-0', className)}>
      <div
        className={cn(
          'flex items-center justify-center rounded-full font-semibold text-white select-none',
          SIZES[size]
        )}
        style={{ backgroundColor: color }}
        aria-hidden="true"
      >
        {initial}
      </div>
      {online !== null && (
        <span
          className={cn(
            'absolute bottom-0 right-0 rounded-full border-2 border-background',
            DOT_SIZES[size],
            online ? 'bg-emerald-500' : 'bg-zinc-300'
          )}
          title={online ? '在线' : '离线'}
        />
      )}
    </div>
  )
}
