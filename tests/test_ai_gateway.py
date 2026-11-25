# -*- coding: utf-8 -*-
"""ai-gateway 的离线单测：路由决策、消息拼装、token 估算。不需要模型。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services" / "ai_gateway"))

import app as gw  # noqa: E402


def body(messages, persona="你是沐雪", privacy=False):
    return gw.ReplyBody(messages=messages, persona=persona, privacy=privacy)


def test_estimate_tokens():
    assert gw.estimate_tokens("你好") == 2
    assert gw.estimate_tokens("hello world") >= 2


def test_device_forced():
    gw.INFERENCE_MODE = "device"
    d, _ = gw.decide(body([{"role": "user", "content": "在吗"}]))
    assert d == "device"


def test_privacy_prefers_device():
    gw.INFERENCE_MODE = "auto"
    gw.CLOUD_BASE_URL = "http://cloud/v1"
    d, reasons = gw.decide(body([{"role": "user", "content": "x" * 5000}], privacy=True))
    assert d == "device", reasons
    assert any("隐私" in r for r in reasons)


def test_long_context_goes_cloud():
    gw.INFERENCE_MODE = "auto"
    gw.CLOUD_BASE_URL = "http://cloud/v1"
    long = "很长" * 1000
    d, reasons = gw.decide(body([{"role": "user", "content": long}]))
    assert d == "cloud", reasons


def test_long_context_without_cloud_falls_back():
    gw.INFERENCE_MODE = "auto"
    gw.CLOUD_BASE_URL = ""
    long = "很长" * 1000
    d, reasons = gw.decide(body([{"role": "user", "content": long}]))
    assert d == "device"
    assert any("云端不可用" in r for r in reasons)


def test_build_messages_injects_persona():
    msgs = gw.build_messages(body([{"role": "user", "content": "在吗"},
                                   {"role": "assistant", "content": "在呀"}]))
    assert msgs[0] == {"role": "system", "content": "你是沐雪"}
    assert msgs[-1]["role"] == "assistant"


def test_build_messages_drops_empty():
    msgs = gw.build_messages(body([{"role": "user", "content": "  "},
                                   {"role": "user", "content": "在吗"}]))
    assert len(msgs) == 2


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print("PASS", fn.__name__)
        except AssertionError as e:
            failed += 1
            print("FAIL", fn.__name__, e)
    print("\n%d passed, %d failed" % (len(fns) - failed, failed))
    sys.exit(1 if failed else 0)
