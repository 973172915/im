# -*- coding: utf-8 -*-
"""把训练好的模型发布到 ModelScope。

用法（先设置环境变量，避免 token 落进命令历史）：

    $env:MODELSCOPE_API_TOKEN = "<你的访问令牌>"
    $env:MODELSCOPE_USER = "<你的用户名>"
    python scripts/publish/upload_to_modelscope.py --only lora

    # 全部发布（约 2.3 GB，受上行带宽限制）
    python scripts/publish/upload_to_modelscope.py

参数：
    --only   lora | voice | mnn | all（默认 all）
    --dir    本地待发布目录根（默认 F:\\modelscope-publish）
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

MODELS = {
    "lora": {
        "name": "muixue-qwen3-4b-lora",
        "license": "cc-by-nc-4.0",
        "message": "发布沐雪 Qwen3-4B LoRA（QLoRA r=8）",
    },
    "voice": {
        "name": "dafeiyu-gpt-sovits-voice",
        "license": "cc-by-nc-4.0",
        "message": "发布大肥鱼 GPT-SoVITS v2 音色（自训练复现）",
    },
    "mnn": {
        "name": "qwen3-4b-roleplay-mnn",
        "license": "cc-by-nc-4.0",
        "message": "发布沐雪 Qwen3-4B MNN int4 端侧模型",
    },
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="all", choices=["all", *MODELS.keys()])
    ap.add_argument("--dir", default=str(Path(r"F:\modelscope-publish")))
    args = ap.parse_args()

    token = os.environ.get("MODELSCOPE_API_TOKEN", "").strip()
    user = os.environ.get("MODELSCOPE_USER", "").strip()
    if not token or not user:
        print("请先设置 MODELSCOPE_API_TOKEN 与 MODELSCOPE_USER")
        return 2

    try:
        from modelscope.hub.api import HubApi
    except ImportError:
        print("缺少 modelscope：pip install modelscope")
        return 2

    api = HubApi()
    api.login(token)

    targets = MODELS.keys() if args.only == "all" else [args.only]
    root = Path(args.dir)

    for key in targets:
        meta = MODELS[key]
        folder = root / meta["name"]
        if not folder.exists():
            print("[skip] 目录不存在: %s" % folder)
            continue

        repo_id = "%s/%s" % (user, meta["name"])
        print("\n=== %s ===" % repo_id)

        try:
            api.create_model(repo_id, visibility=5, license=meta["license"])
            print("已创建仓库")
        except Exception as e:  # 已存在时忽略
            print("仓库已存在或创建跳过: %s" % str(e)[:80])

        size = sum(f.stat().st_size for f in folder.rglob("*") if f.is_file())
        print("上传 %.1f MB …（大文件可能较久）" % (size / 1024 / 1024))

        api.upload_folder(
            repo_id=repo_id,
            folder_path=str(folder),
            commit_message=meta["message"],
        )
        print("完成: https://modelscope.cn/models/%s" % repo_id)

    return 0


if __name__ == "__main__":
    sys.exit(main())
