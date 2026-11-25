# -*- coding: utf-8 -*-
"""mnn_stream.exe 的 Python 客户端。

C++ 侧（services/device/mnn_stream.cpp）是一个长驻进程：
  stdin  收 "REQ / MAX / MSG / END" 帧
  stdout 逐 token 吐 {"t":"d","x":"..."}，最后 {"t":"e"}

这样拿流式不需要跨线程访问 MNN 内部状态，也就不会再有 0xC0000005。
"""
from __future__ import annotations

import asyncio
import json
import subprocess
import threading
from pathlib import Path
from typing import Any, AsyncIterator, Iterable


class MnnStreamClient:
    def __init__(self, exe: str, config: str):
        self.exe = exe
        self.config = config
        self.proc: subprocess.Popen | None = None
        self.lock = threading.Lock()
        self.dirty = False        # 上次生成被中断，进程里还有没读完的输出

    # ---------- 生命周期 ----------
    def start(self, timeout: float = 120.0) -> None:
        if self.dirty:
            # 被打断的进程输出已经和请求对不上，直接重启（约 1 秒）
            self.close()
            self.dirty = False
        if self.proc is not None and self.proc.poll() is None:
            return
        self.proc = subprocess.Popen(
            [self.exe, self.config],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,          # 直接继承，MNN 的日志留在控制台
            bufsize=0,
        )
        # 等 ready 行；MNN 会先往 stdout 打自己的日志，跳过非 JSON 行
        while True:
            line = self._readline_blocking()
            if not line:
                raise RuntimeError("mnn_stream 启动失败：进程没有输出")
            if not line.startswith("{"):
                continue
            if json.loads(line).get("t") == "ready":
                return

    def close(self) -> None:
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.stdin.close()
                self.proc.wait(timeout=5)
            except Exception:
                self.proc.kill()
        self.proc = None

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    # ---------- IO ----------
    def _readline_blocking(self, timeout: float | None = None) -> str:
        assert self.proc is not None
        out = self.proc.stdout
        assert out is not None
        # 简单起见：readline 本身阻塞；超时由调用方控制（生成阶段不设超时）
        return out.readline().decode("utf-8", "replace").strip()

    def _send(self, messages: Iterable[tuple[str, str]], max_tokens: int) -> None:
        assert self.proc is not None and self.proc.stdin is not None
        buf = bytearray(b"REQ\n")
        buf += ("MAX %d\n" % max_tokens).encode()
        for role, content in messages:
            body = content.encode("utf-8")
            buf += ("MSG %s %d\n" % (role, len(body))).encode()
            buf += body + b"\n"
        buf += b"END\n"
        self.proc.stdin.write(buf)
        self.proc.stdin.flush()

    # ---------- 生成 ----------
    async def generate(self, messages: list[dict[str, Any]], max_tokens: int = 256
                       ) -> AsyncIterator[str]:
        loop = asyncio.get_running_loop()
        # 整个生成期间独占，避免两个请求交错读 stdout
        await loop.run_in_executor(None, self.lock.acquire)
        finished = False
        try:
            self.start()
            self._send([(m["role"], m["content"]) for m in messages], max_tokens)

            async def read_line() -> str:
                return await loop.run_in_executor(None, self._readline_blocking)

            while True:
                line = await read_line()
                if not line:
                    raise RuntimeError("mnn_stream 进程退出")
                if not line.startswith("{"):
                    continue                      # MNN 自己的日志行，跳过
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                t = obj.get("t")
                if t == "d":
                    yield obj.get("x", "")
                elif t == "e":
                    finished = True
                    return
                elif t == "err":
                    finished = True
                    raise RuntimeError(obj.get("x", "unknown error"))
        finally:
            if not finished:
                # 被打断：进程里还有没读完的 token，标记为脏，下次请求前重启
                self.dirty = True
            self.lock.release()

