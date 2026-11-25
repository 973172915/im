# 推理性能压测

## 环境

| 项 | 值 |
| --- | --- |
| CPU | AMD Ryzen 5 5600（6C/12T） |
| 内存 | 32 GB |
| GPU | 无（端侧纯 CPU） |
| 模型 | Qwen3-4B + 沐雪 LoRA → MNN int4（2.0 GB） |
| 后端 | `mnn_stream` 子进程，`device:9000` |
| 压测工具 | `scripts/bench/bench_gateway.py`（httpx + asyncio） |

## 方法

- 每个请求都问「在吗」，`max_tokens=24`，`temperature=0.7`
- 每次 4 个请求，并发分别为 1 / 2 / 4
- 记录 **TTFT**（首个 delta 到达）、总延迟、输出 token 数、tok/s
- 同一轮里先预热一次，避免模型加载影响

```bash
python scripts/bench/bench_gateway.py --mode gateway --requests 4 --concurrency 1
python scripts/bench/bench_gateway.py --mode device  --requests 4 --concurrency 1
```

## 结果

### 直连 device（绕过网关）

| 指标 | 值 |
| --- | --- |
| TTFT p50 / p95 | **0.42 / 0.48 s** |
| 总延迟 p50 / p95 | **0.90 / 0.96 s** |
| 生成速度 | 16.8 tok/s |
| 吞吐 | 1.10 req/s（并发 1） |

### 经 ai-gateway

| 并发 | TTFT p50 | TTFT p95 | 总延迟 p50 | 吞吐 req/s | tok/s |
| --- | --- | --- | --- | --- | --- |
| 1 | 0.55 s | 0.68 s | 1.02 s | 0.98 | 16.9 |
| 2 | 1.34 s | 1.49 s | 1.80 s | 1.13 | 17.3 |
| 4 | **2.52 s** | **3.29 s** | 2.86 s | 1.05 | 17.2 |

## 分析

### ① 网关开销约 0.12 s

```
直连 0.42s  →  经网关 0.55s
```

多一次 HTTP 转发 + SSE 重新编码，占 13%。换来的是端云路由、统一协议、降级能力，值得。

### ② 生成速度恒定，吞吐不涨

| 并发 | tok/s |
| --- | --- |
| 1 | 16.9 |
| 2 | 17.3 |
| 4 | 17.2 |

**tok/s 几乎不变**说明模型是**单实例串行**推理，并发不会让生成变快——MNN 没有 continuous batching。

### ③ 并发只增加排队

```
TTFT:   0.55s (c=1)  →  1.34s (c=2)  →  2.52s (c=4)
```

近似线性增长，说明请求在模型前排队。吞吐平台在 ~1.05 req/s。

**p95 尤其明显**：4 个用户同时说话，最慢的那个要等 3.3 秒才看到第一个字。

## 对产品的含义

| 场景 | 结论 |
| --- | --- |
| 个人使用 / 1v1 聊天 | 完全够用（1.0–1.5 s 出完整回复） |
| 小群聊（3–5 人同时 @） | 可感知变慢（2–3 s） |
| 高并发 SaaS | 单实例不够，必须多实例或上云端 |

## 可选的优化方向

| 方向 | 预期效果 | 成本 |
| --- | --- | --- |
| 多进程实例 + 负载均衡 | 吞吐近似线性 | 中（内存 ×N） |
| 限制并发（信号量 1–2）+ 排队提示 | p95 可控，体验更诚实 | 低 |
| 路由到云端（vLLM continuous batching） | 吞吐随并发上升 | 需 GPU |
| 缩短回复（当前 ~25 字） | 直接线性降低总延迟 | 已做 |

## 与 vLLM 的对比（待测）

同一脚本切到云端即可对比：

```bash
# GPU 机器上
vllm serve <merged-model> --served-model-name qwen3-4b-roleplay --port 8000

# 网关切 cloud 后压测
python scripts/bench/bench_gateway.py --mode gateway --requests 4 --concurrency 4
```

预期（A10）：vLLM 有 continuous batching，**并发 4 时 tok/s 和吞吐应显著高于端侧**，
这正是"端云路由"的产品依据：闲聊走端侧（便宜、离线），并发高或复杂问题走云端。

## 复现

```bash
# 端侧基线
python scripts/bench/bench_gateway.py --mode device  --requests 4 --concurrency 1
# 网关 + 不同并发
python scripts/bench/bench_gateway.py --mode gateway --requests 4 --concurrency 4
```
