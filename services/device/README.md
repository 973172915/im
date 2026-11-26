# device

端侧 4B int4 推理服务（MNN）。

## 组成

| 文件 | 说明 |
| --- | --- |
| `server.py` | FastAPI 包装，提供 OpenAI 兼容的 `/v1/chat/completions`（支持 SSE） |
| `stream_client.py` | 与 `mnn_stream` 子进程通信（长度前缀协议） |
| `mnn_stream.cpp` | 子进程源码：加载 MNN 模型并流式吐 token |

`mnn_stream.exe` 是编译产物，**不入库**（约 3.8 MB，Windows x64）。

## 编译 mnn_stream

需要 MSVC + MNN 源码：

```powershell
# 1. 拉取 MNN
git clone https://github.com/alibaba/MNN.git

# 2. 用 CMake 生成工程（示例：x64 Release）
cmake -S MNN -B MNN\build -A x64 -DCMAKE_BUILD_TYPE=Release -DMNN_BUILD_LLM=ON

# 3. 编译
cmake --build MNN\build --config Release

# 4. 编译本目录的 mnn_stream.cpp（链接 MNN）
cl /EHsc /std:c++17 /I MNN\include mnn_stream.cpp /link /LIBPATH:MNN\build\Release MNN.lib
```

或直接用 MNN 官方的 `llm_demo` / MNN-Chat 取代本子进程方案。

## 运行

```powershell
cd services/device
$env:MNN_MODEL_DIR = "F:\mnn-test\qwen3-4b-roleplay-v5-mnn"
$env:MODEL_ID      = "qwen3-4b-roleplay"
$env:MNN_STREAM_EXE = "$PWD\mnn_stream.exe"
python -m uvicorn server:app --host 127.0.0.1 --port 9000
```

## 模型

MNN int4 模型目录应包含：

```
llm.mnn          图的拓扑
llm.mnn.weight   int4 权重（约 2.0 GB）
llm_config.json  chat template 等配置
config.json
tokenizer.mtok
```

由 `training/` 的导出流程生成（LLM 用 `llmexport --quant_bit 4 --hqq`）。

## 性能

| 硬件 | 速度 |
| --- | --- |
| Ryzen 5 5600（6C/12T，CPU） | 约 11 tok/s |
| A10 GPU（vLLM 对比） | 约 30–50 tok/s |

端侧的价值是**离线可用 + 零请求成本**，不是绝对速度。
