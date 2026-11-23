'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { MessageCircle, Sparkles, Loader2, UserRound, KeyRound, IdCard } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { api } from '@/lib/api'
import { useIMStore } from '@/store/im-store'

export function AuthScreen() {
  const { toast } = useToast()
  const setMe = useIMStore((s) => s.setMe)
  const setToken = useIMStore((s) => s.setToken)

  // 登录表单
  const [loginUsername, setLoginUsername] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)

  // 注册表单
  const [regUsername, setRegUsername] = useState('')
  const [regNickname, setRegNickname] = useState('')
  const [regPassword, setRegPassword] = useState('')
  const [regPassword2, setRegPassword2] = useState('')
  const [regLoading, setRegLoading] = useState(false)

  async function handleLogin(e?: React.FormEvent) {
    e?.preventDefault()
    if (loginLoading) return
    setLoginLoading(true)
    try {
      const { user, token } = await api.login({
        username: loginUsername.trim(),
        password: loginPassword,
      })
      setMe(user)
      setToken(token)
      toast({ title: `欢迎回来，${user.nickname}` })
    } catch (err) {
      toast({
        title: '登录失败',
        description: err instanceof Error ? err.message : '请稍后再试',
        variant: 'destructive',
      })
    } finally {
      setLoginLoading(false)
    }
  }

  async function handleRegister(e?: React.FormEvent) {
    e?.preventDefault()
    if (regLoading) return
    if (regPassword !== regPassword2) {
      toast({ title: '两次输入的密码不一致', variant: 'destructive' })
      return
    }
    setRegLoading(true)
    try {
      const { user, token } = await api.register({
        username: regUsername.trim(),
        password: regPassword,
        nickname: regNickname.trim() || undefined,
      })
      setMe(user)
      setToken(token)
      toast({ title: `注册成功，欢迎加入灵犀 IM，${user.nickname}` })
    } catch (err) {
      toast({
        title: '注册失败',
        description: err instanceof Error ? err.message : '请稍后再试',
        variant: 'destructive',
      })
    } finally {
      setRegLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-emerald-50 via-stone-50 to-amber-50 p-4">
      <div className="w-full max-w-md">
        {/* 品牌区 */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500 shadow-lg shadow-emerald-500/30">
            <MessageCircle className="h-8 w-8 text-white" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-stone-900">灵犀 IM</h1>
          <p className="mt-2 flex items-center justify-center gap-1 text-sm text-stone-500">
            <Sparkles className="h-3.5 w-3.5 text-amber-500" />
            心有灵犀，一触即达的即时通讯
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-6 shadow-xl shadow-stone-200/50 sm:p-8">
          <Tabs defaultValue="login">
            <TabsList className="mb-6 grid w-full grid-cols-2">
              <TabsTrigger value="login">登录</TabsTrigger>
              <TabsTrigger value="register">注册</TabsTrigger>
            </TabsList>

            {/* 登录 */}
            <TabsContent value="login">
              <form onSubmit={handleLogin} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="login-username">用户名</Label>
                  <div className="relative">
                    <UserRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
                    <Input
                      id="login-username"
                      placeholder="请输入用户名"
                      className="pl-9"
                      value={loginUsername}
                      onChange={(e) => setLoginUsername(e.target.value)}
                      autoComplete="username"
                      required
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="login-password">密码</Label>
                  <div className="relative">
                    <KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
                    <Input
                      id="login-password"
                      type="password"
                      placeholder="请输入密码"
                      className="pl-9"
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                      autoComplete="current-password"
                      required
                    />
                  </div>
                </div>
                <Button
                  type="submit"
                  className="w-full bg-emerald-500 hover:bg-emerald-600"
                  disabled={loginLoading || !loginUsername.trim() || !loginPassword}
                >
                  {loginLoading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 登录中…
                    </>
                  ) : (
                    '登 录'
                  )}
                </Button>
              </form>
            </TabsContent>

            {/* 注册 */}
            <TabsContent value="register">
              <form onSubmit={handleRegister} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="reg-username">用户名</Label>
                  <div className="relative">
                    <UserRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
                    <Input
                      id="reg-username"
                      placeholder="3-20 位字母、数字或下划线"
                      className="pl-9"
                      value={regUsername}
                      onChange={(e) => setRegUsername(e.target.value)}
                      autoComplete="username"
                      required
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="reg-nickname">昵称</Label>
                  <div className="relative">
                    <IdCard className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
                    <Input
                      id="reg-nickname"
                      placeholder="展示给他人的名称（可选）"
                      className="pl-9"
                      value={regNickname}
                      onChange={(e) => setRegNickname(e.target.value)}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="reg-password">密码</Label>
                  <div className="relative">
                    <KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
                    <Input
                      id="reg-password"
                      type="password"
                      placeholder="至少 6 位"
                      className="pl-9"
                      value={regPassword}
                      onChange={(e) => setRegPassword(e.target.value)}
                      autoComplete="new-password"
                      required
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="reg-password2">确认密码</Label>
                  <div className="relative">
                    <KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
                    <Input
                      id="reg-password2"
                      type="password"
                      placeholder="再输入一次密码"
                      className="pl-9"
                      value={regPassword2}
                      onChange={(e) => setRegPassword2(e.target.value)}
                      autoComplete="new-password"
                      required
                    />
                  </div>
                </div>
                <Button
                  type="submit"
                  className="w-full bg-emerald-500 hover:bg-emerald-600"
                  disabled={regLoading || !regUsername.trim() || !regPassword || !regPassword2}
                >
                  {regLoading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 注册中…
                    </>
                  ) : (
                    '创建账号'
                  )}
                </Button>
              </form>
            </TabsContent>
          </Tabs>
        </div>

        <p className="mt-6 text-center text-xs text-stone-400">
          注册多个账号并分别登录（不同浏览器窗口），即可体验实时聊天
        </p>
      </div>
    </div>
  )
}
