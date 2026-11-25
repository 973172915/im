---
license: cc-by-nc-4.0
language:
  - zh
tags:
  - gpt-sovits
  - text-to-speech
  - voice-cloning
  - tts
pretty_name: 大肥鱼 GPT-SoVITS v2 音色（自训练复现）
---

# 大肥鱼 GPT-SoVITS v2 音色模型

用 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) **v2final** 在公开数据集上微调的中文少女音色，
配套项目：[灵犀 IM](https://github.com/973172915/im)。

这是一份**可复现的独立训练结果**：从原始音频开始完整走完预处理、SoVITS 训练、GPT 训练、推理验证，
不是搬运现成权重。

## 数据

| 项 | 值 |
| --- | --- |
| 来源 | `YinZilu/da-fei-yu-girl-voice-zh` |
| 许可 | **CC-BY-NC-4.0（非商业，须署名）** |
| 作者 | 尹紫鹭幻想社 |
| 规模 | 145 条带文本语音，18 分 29 秒 |
| 处理 | 统一重采样为 32 kHz 单声道 16 bit |

**音色来源声明**：声音来自 B 站 UP 主「尹紫鹭幻想社」自行调制的角色「大肥鱼」，
本模型仅为非商业研究复现，不代表原作者授权或背书。

## 训练配置

| 阶段 | 关键超参 |
| --- | --- |
| SoVITS (s2) | batch 4，10 epoch，lr 1e-4，fp16，`lora_rank=32`，`segment_size=20480` |
| GPT (s1) | batch 4，10 epoch，lr 0.01（warmup 2000），`max_sec=54` |
| 底模 | `s2G2333k.pth` / `s2D2333k.pth` / `s1bert25hz-5kh-...ckpt`（官方 v2final） |
| 环境 | Python 3.10，torch 2.4.0+cu121，transformers 4.52.4，单卡 A10 |

训练耗时：SoVITS 约 2 分钟（10 epoch × 39 step），GPT 约 2 分钟，GPT top_3_acc 0.646。

## 文件

| 文件 | 说明 |
| --- | --- |
| `dafeiyu-e10.ckpt` | GPT（s1）权重，149 MB |
| `dafeiyu_e10_s390.pth` | SoVITS（s2）权重，82 MB |
| `ref_dafeiyu.wav` | 参考音频（4.47 秒） |
| `ref_prompt.txt` | 参考音频对应文本 |
| `sample_tts.wav` | 合成样例（32 kHz） |
| `tts_infer.yaml` | 推理配置模板（已指向本模型） |
| `s1_dafeiyu.yaml` / `s2_dafeiyu.json` | 训练超参快照 |
| `metadata.csv` | 训练清单（145 条） |
| `s1_train.log` / `s2_train.log` / `train_voice.log` | 训练日志 |

## 使用

```bash
git clone https://github.com/RVC-Boss/GPT-SoVITS.git && cd GPT-SoVITS
# 权重放到：
#   GPT_weights_v2/dafeiyu-e10.ckpt
#   SoVITS_weights_v2/dafeiyu_e10_s390.pth
python api_v2.py -a 0.0.0.0 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
```

```bash
curl -X POST http://127.0.0.1:9880/tts -H "Content-Type: application/json" -d '{
  "text": "在哦，有什么事吗？",
  "text_lang": "zh",
  "ref_audio_path": "ref_dafeiyu.wav",
  "prompt_text": "什么嘛，这么简单的事情，你居然专门跑来问我。",
  "prompt_lang": "zh",
  "text_split_method": "cut5",
  "batch_size": 1,
  "media_type": "wav",
  "streaming_mode": false
}' -o out.wav
```

CPU 可跑，约 8 秒/句（32 kHz）；GPU 可实时。

## 已知限制

- 训练数据仅 18.5 分钟，音色稳定性有限，长句语调可能漂移
- 参考音频需 **3–10 秒**，超范围会报错
- 仅中文；情感/语速控制靠更换参考音频实现
- **禁止商用**

## 复现踩坑

| 问题 | 处理 |
| --- | --- |
| `jieba_fast` 无 cp310/cp312 轮子 | `import jieba as jieba_fast` |
| transformers ≥4.49 拒绝 torch<2.6 读 `.bin` | monkeypatch `check_torch_load_is_safe` |
| G2PW 模型下载失败 | 手动下载 `G2PWModel_1.1.zip` 并展平目录 |
| `fast_langdetect` 缺 `lid.176.bin` | 手动放入 `pretrained_models/fast_langdetect/` |
| 训练产物带 `-0` 后缀 | 复制成不带后缀的文件名再训练 |
| 权重目录不存在 | 提前 `mkdir -p SoVITS_weights_v2 GPT_weights_v2` |

## 署名

```
音色训练数据：YinZilu/da-fei-yu-girl-voice-zh
  作者：尹紫鹭幻想社
  许可：CC-BY-NC-4.0
```

本模型由上述数据微调得到，遵循相同许可，仅限非商业使用。
