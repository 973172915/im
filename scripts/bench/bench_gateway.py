# -*- coding: utf-8 -*-
"""推理链路压测：TTFT / 总延迟 / 吞吐 / tok/s。

支持两种后端：
    gateway  ai-gateway 的 /v1/reply（SSE，type=delta）
    device   device 的 /v1/chat/completions（OpenAI 兼容，SSE）

用法：
    python scripts/bench/bench_gateway.py --mode gateway --requests 6 --concurrency 1
    python scripts/bench/bench_gateway.py --mode device  --requests 6 --concurrency 2 --max-tokens 24

输出：逐请求明细 + p50/p95 汇总 + 吞吐。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import time
from dataclasses import dataclass

import httpx

PERSONA = "你是一个名为沐雪的可爱AI女孩子"


@dataclass
class Result:
    ttft: float
    total: float
    tokens: int
    chars: int
    error: str | None = None


async def one_gateway(client: httpx.AsyncClient, url: str, max_tokens: int) -> Result:
    payload = {
        "messages": [{"role": "user", "content": "在吗"}],
        "persona": PERSONA,
        "session_id": "bench",
        "max_tokens": max_tokens,
        "temperature": 0.7,
    }
    t0 = time.perf_counter()
    ttft = 0.0
    tokens = 0
    chars = 0
    try:
        async with client.stream("POST", url, json=payload, timeout=None) as r:
            if r.status_code != 200:
                body = (await r.aread())[:120]
                return Result(0, 0, 0, 0, "HTTP %d %s" % (r.status_code, body))
            async for line in r.aiter_lines():
                if not line.startswith("data:"):
                    continue
                try:
                    evt = json.loads(line[5:].strip())
                except json.JSONDecodeError:
                    continue
                if evt.get("type") == "delta" and evt.get("text"):
                    if ttft == 0.0:
                        ttft = time.perf_counter() - t0
                    tokens += 1
                    chars += len(evt["text"])
                elif evt.get("type") == "error":
                    return Result(ttft, 0, tokens, chars, evt.get("message", "error"))
                elif evt.get("type") == "done":
                    break
    except Exception as e:  # noqa: BLE001
        return Result(ttft, 0, tokens, chars, "%s: %s" % (type(e).__name__, str(e)[:60]))
    return Result(ttft, time.perf_counter() - t0, tokens, chars)


async def one_device(client: httpx.AsyncClient, url: str, max_tokens: int) -> Result:
    payload = {
        "model": "qwen3-4b-roleplay",
        "messages": [
            {"role": "system", "content": PERSONA},
            {"role": "user", "content": "在吗"},
        ],
        "max_tokens": max_tokens,
        "temperature": 0.7,
        "stream": True,
    }
    t0 = time.perf_counter()
    ttft = 0.0
    tokens = 0
    chars = 0
    try:
        async with client.stream("POST", url, json=payload, timeout=None) as r:
            if r.status_code != 200:
                body = (await r.aread())[:120]
                return Result(0, 0, 0, 0, "HTTP %d %s" % (r.status_code, body))
            async for line in r.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    obj = json.loads(data)
                except json.JSONDecodeError:
                    continue
                delta = (obj.get("choices") or [{}])[0].get("delta", {}).get("content")
                if delta:
                    if ttft == 0.0:
                        ttft = time.perf_counter() - t0
                    tokens += 1
                    chars += len(delta)
    except Exception as e:  # noqa: BLE001
        return Result(ttft, 0, tokens, chars, "%s: %s" % (type(e).__name__, str(e)[:60]))
    return Result(ttft, time.perf_counter() - t0, tokens, chars)


def pct(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, int(round((p / 100) * (len(ordered) - 1)))))
    return ordered[idx]


async def run(args) -> int:
    if args.mode == "gateway":
        url = args.url or "http://127.0.0.1:9200/v1/reply"
        fn = one_gateway
    else:
        url = args.url or "http://127.0.0.1:9000/v1/chat/completions"
        fn = one_device

    print("目标 %s" % url)
    print("请求数 %d  并发 %d  max_tokens %d\n" % (args.requests, args.concurrency, args.max_tokens))

    sem = asyncio.Semaphore(args.concurrency)
    results: list[Result] = []

    async with httpx.AsyncClient() as client:
        async def task() -> None:
            async with sem:
                results.append(await fn(client, url, args.max_tokens))

        t0 = time.perf_counter()
        await asyncio.gather(*(task() for _ in range(args.requests)))
        wall = time.perf_counter() - t0

    ok = [r for r in results if not r.error]
    err = [r for r in results if r.error]

    print("%-4s %8s %8s %7s %7s %s" % ("#", "TTFT(s)", "总(s)", "tok", "tok/s", "状态"))
    for i, r in enumerate(results, 1):
        tps = (r.tokens / (r.total - r.ttft)) if r.total > r.ttft and r.tokens else 0.0
        print("%-4d %8.2f %8.2f %7d %7.1f %s" % (i, r.ttft, r.total, r.tokens, tps, r.error or "ok"))

    print("\n=== 汇总 ===")
    if ok:
        ttfts = [r.ttft for r in ok]
        totals = [r.total for r in ok]
        total_tokens = sum(r.tokens for r in ok)
        gen_time = sum(max(r.total - r.ttft, 0.001) for r in ok)
        print("成功 %d / %d" % (len(ok), len(results)))
        print("TTFT     p50 %.2fs  p95 %.2fs  min %.2fs" % (pct(ttfts, 50), pct(ttfts, 95), min(ttfts)))
        print("总延迟   p50 %.2fs  p95 %.2fs  max %.2fs" % (pct(totals, 50), pct(totals, 95), max(totals)))
        print("生成速度 %.1f tok/s（聚合）" % (total_tokens / gen_time if gen_time else 0))
        print("吞吐     %.3f req/s（墙钟 %.1fs）" % (len(ok) / wall, wall))
        print("平均输出 %.0f token / %.0f 字" % (total_tokens / len(ok), sum(r.chars for r in ok) / len(ok)))
    if err:
        print("失败 %d 个，首个错误：%s" % (len(err), err[0].error))
    return 0 if not err else 1


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["gateway", "device"], default="gateway")
    ap.add_argument("--url", default="")
    ap.add_argument("--requests", type=int, default=6)
    ap.add_argument("--concurrency", type=int, default=1)
    ap.add_argument("--max-tokens", type=int, default=24)
    args = ap.parse_args()
    raise SystemExit(asyncio.run(run(args)))


if __name__ == "__main__":
    main()
