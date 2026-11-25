# refs

GPT-SoVITS 推理用的参考音频（3–10 秒）。

| 文件 | 来源 | 许可 |
| --- | --- | --- |
| `dafeiyu_ref.wav` | `YinZilu/da-fei-yu-girl-voice-zh` 数据集中的一条（4.47 秒） | CC-BY-NC-4.0（尹紫鹭幻想社） |

参考音频决定音色和情绪，换一段 3–10 秒、干净无底噪的音频即可换音色。

**用途限制**：仅非商业研究/演示；不得声称音色为原创，不得用于商业产品。

## 为什么放在仓库里

`voices.json` 用相对路径 `services/voice/refs/dafeiyu_ref.wav` 引用它，
这样 clone 下来、装好 GPT-SoVITS 就能直接跑语音，不用再单独找素材。

文件仅 279 KB，且已注明来源与许可。
