#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成一份可以直接复制过去启动的懒大猫 API 演示数据库。

做法不是手写 BoltDB，而是：
  1. 在本机启动一个假的 OpenAI / Anthropic / Gemini 上游；
  2. 用临时数据目录启动当前源码编译出的网关；
  3. 通过管理接口创建渠道、模型、提供商、令牌和站点设置；
  4. 真实调用 /v1/* 与 /api/chat，让网关自己写出日志、统计和令牌用量；
  5. 停掉网关，把 ldmapi.db 复制到指定位置。

这样生成的日志、重试明细、Key 尝试、亲和标记、流式速度、取消记录都和线上完全一致。

用法：
  python scripts/gen_demo_data.py
  python scripts/gen_demo_data.py --out demo-data/ldmapi.db --spread-days 7
  python scripts/gen_demo_data.py --binary dist/ldmapi-windows-amd64.exe

默认管理端密码是 landamao（与程序默认值一致），生成后可直接登录演示。
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import http.cookiejar
import json
import os
import random
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = PROJECT_ROOT / "demo-data" / "ldmapi.db"
DEFAULT_PASSWORD = "landamao"

# ---------------------------------------------------------------------------
# 演示用的固定上游 Key（只存在于假上游和演示库里）
# ---------------------------------------------------------------------------

MAIN_KEY = "sk-demo-main-7f3a9c2e"
BULK_KEYS = [
    "sk-demo-bulk-1-expired",
    "sk-demo-bulk-2-ratelimit",
    "sk-demo-bulk-3-good",
]
RANDOM_KEYS = [
    "sk-demo-random-a1b2c3d4",
    "sk-demo-random-e5f6a7b8",
    "sk-demo-random-c9d0e1f2",
]
DEEPSEEK_KEYS = [
    "sk-demo-deepseek-1-expired",
    "sk-demo-deepseek-2-good",
    "sk-demo-deepseek-3-backup",
]
ANTHROPIC_KEY = "sk-demo-anthropic-1-good"
GEMINI_KEY = "sk-demo-gemini-1-good"
REVOKED_KEY = "sk-demo-revoked-1-dead"
RATELIMIT_KEY = "sk-demo-ratelimit-1-throttled"
BROKEN_KEY = "sk-demo-broken-1-outage"
LEGACY_KEY = "sk-demo-legacy-1-old"

CLIENT_IPS = [
    "203.0.113.10",
    "198.51.100.24",
    "192.0.2.77",
    "10.0.0.12",
    "172.16.0.8",
    "203.0.113.88",
]

# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------


def free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def json_request(
    url: str,
    method: str = "GET",
    payload: Any = None,
    headers: dict[str, str] | None = None,
    opener: Any = None,
    timeout: float = 30.0,
) -> tuple[int, dict[str, str], bytes]:
    """返回 (状态码, 响应头, 响应体)，4xx/5xx 不抛异常。"""
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "ldmapi-demo-seed/1.0")
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    try:
        if opener is not None:
            resp = opener.open(req, timeout=timeout)
        else:
            resp = urllib.request.urlopen(req, timeout=timeout)
        body = resp.read()
        return int(resp.status), {k.lower(): v for k, v in resp.headers.items()}, body
    except urllib.error.HTTPError as e:
        body = e.read()
        return int(e.code), {k.lower(): v for k, v in e.headers.items()}, body


def wait_for_http(url: str, timeout: float) -> None:
    deadline = time.time() + timeout
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            status, _, _ = json_request(url, timeout=2.0)
            if status < 500:
                return
        except Exception as exc:  # noqa: BLE001 - 启动阶段什么错都可能出现
            last_error = exc
        time.sleep(0.15)
    raise RuntimeError(f"等待 {url} 超时: {last_error}")


class ApiError(RuntimeError):
    def __init__(self, method: str, path: str, status: int, body: str):
        super().__init__(f"{method} {path} -> HTTP {status}: {body}")
        self.status = status
        self.body = body


class AdminAPI:
    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar)
        )

    def call(
        self,
        method: str,
        path: str,
        payload: Any = None,
        headers: dict[str, str] | None = None,
        timeout: float = 30.0,
    ) -> Any:
        status, _, body = json_request(
            self.base + path,
            method=method,
            payload=payload,
            headers=headers,
            opener=self.opener,
            timeout=timeout,
        )
        text = body.decode("utf-8", "replace")
        if status >= 400:
            raise ApiError(method, path, status, text)
        if not text:
            return None
        return json.loads(text)

    def get(self, path: str) -> Any:
        return self.call("GET", path)

    def post(self, path: str, payload: Any) -> Any:
        return self.call("POST", path, payload)

    def put(self, path: str, payload: Any) -> Any:
        return self.call("PUT", path, payload)

    def open_stream(
        self, path: str, payload: Any, headers: dict[str, str] | None = None
    ) -> Any:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(self.base + path, data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        if headers:
            for k, v in headers.items():
                req.add_header(k, v)
        return self.opener.open(req, timeout=30.0)


# ---------------------------------------------------------------------------
# 假上游
# ---------------------------------------------------------------------------


def extract_prompt(body: dict[str, Any]) -> str:
    """从 OpenAI / Anthropic / Gemini 三种请求体里取出最后一条用户文本。"""
    msgs = body.get("messages")
    if isinstance(msgs, list):
        for msg in reversed(msgs):
            if not isinstance(msg, dict):
                continue
            if msg.get("role") not in ("user", "system", "developer"):
                continue
            content = msg.get("content")
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                parts = []
                for item in content:
                    if isinstance(item, str):
                        parts.append(item)
                    elif isinstance(item, dict) and isinstance(item.get("text"), str):
                        parts.append(item["text"])
                if parts:
                    return "\n".join(parts)
    contents = body.get("contents")
    if isinstance(contents, list):
        parts = []
        for item in reversed(contents):
            if not isinstance(item, dict):
                continue
            for part in item.get("parts") or []:
                if isinstance(part, dict) and isinstance(part.get("text"), str):
                    parts.append(part["text"])
            if parts:
                return "\n".join(parts)
    prompt = body.get("prompt")
    if isinstance(prompt, str):
        return prompt
    return ""


def split_text(text: str, pieces: int) -> list[str]:
    text = text or ""
    if not text:
        return []
    n = max(1, min(pieces, len(text)))
    size = max(1, len(text) // n)
    out = [text[i : i + size] for i in range(0, len(text), size)]
    return out[:n]


def demo_text(channel: str, model: str, prompt: str) -> str:
    short = (prompt or "你好").strip().replace("\n", " ")[:38]
    return (
        f"这是来自 {channel} / {model} 的模拟回复。"
        f"我收到了你的请求「{short}」。"
        "这段内容由演示脚本生成，用于填充日志中的 token、耗时和流式速度。"
    )


def demo_reasoning(model: str) -> str:
    return (
        f"先判断问题类型：这是 {model} 的演示请求。"
        "接着拆解步骤：确认模型、检查路由、评估耗时，最后组织回答。"
        "整个思考过程会作为 reasoning_content 返回，并在日志里统计字符数与 token。"
    )


def make_usage(model: str, prompt: str, text: str, reasoning: str, heavy: bool) -> dict[str, Any]:
    if heavy:
        return {
            "prompt_tokens": 80000,
            "completion_tokens": 20000,
            "total_tokens": 100000,
            "prompt_tokens_details": {"cached_tokens": 32000},
            "completion_tokens_details": {"reasoning_tokens": 6000},
        }
    digest = hashlib.sha256((model + "\x00" + prompt).encode("utf-8")).digest()
    prompt_tokens = 160 + digest[0] * 3 + digest[1] % 97
    completion_tokens = max(24, len(text) // 2 + digest[2] % 220)
    cached = prompt_tokens * (digest[3] % 28) // 100
    reasoning_tokens = 0
    if reasoning:
        reasoning_tokens = max(12, len(reasoning) // 2 + digest[4] % 60)
        completion_tokens += reasoning_tokens
    return {
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": prompt_tokens + completion_tokens,
        "prompt_tokens_details": {"cached_tokens": cached},
        "completion_tokens_details": {"reasoning_tokens": reasoning_tokens},
    }


def failure_message(status: int) -> str:
    return {
        400: "模拟的请求参数错误：messages 不能为空",
        401: "invalid api key (simulated expired key)",
        403: "permission denied (simulated)",
        429: "rate limit exceeded (simulated)",
        500: "upstream internal error (simulated outage)",
        503: "upstream unavailable (simulated)",
    }.get(status, f"simulated upstream error {status}")


class MockState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.hits: list[dict[str, Any]] = []

    def record(self, channel: str, model: str, key: str, status: int, stream: bool) -> None:
        masked = ""
        if key:
            masked = key[:4] + "****" + key[-4:] if len(key) > 8 else "****"
        with self.lock:
            self.hits.append(
                {
                    "channel": channel,
                    "model": model,
                    "key": masked,
                    "status": status,
                    "stream": stream,
                }
            )

    def failure_status(self, channel: str, key: str, prompt: str) -> int:
        # 固定故障渠道
        if channel == "demo-broken":
            return 500
        if channel == "demo-ratelimit":
            return 429
        if channel == "demo-revoked":
            return 401
        # 多 Key 渠道里指定哪些 Key 会失败
        if channel == "demo-bulk":
            if key == BULK_KEYS[0]:
                return 401
            if key == BULK_KEYS[1]:
                return 429
        if channel == "demo-deepseek" and key == DEEPSEEK_KEYS[0]:
            return 401
        # 客户端请求本身有问题的 4xx，用于展示原样透传
        if "trigger-400" in prompt:
            return 400
        return 0


class MockHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "ldmapi-demo-upstream/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        return

    # ---- 基础响应 ----

    def _send_json(self, status: int, obj: Any) -> None:
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True

    def _send_sse_headers(self, broken: bool = False) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        # 故意声明一个比实际内容大得多的长度，网关会读到 unexpected EOF，
        # 从而生成「响应已开始但上游中途断开」的红色 200 日志。
        if broken:
            self.send_header("Content-Length", "99999999")
        self.end_headers()
        self.close_connection = True

    def _write_sse(self, data: bytes) -> None:
        self.wfile.write(data)
        self.wfile.flush()

    # ---- 请求分发 ----

    def do_POST(self) -> None:  # noqa: N802
        try:
            self._handle_post()
        except (BrokenPipeError, ConnectionResetError, OSError):
            # 客户端取消流式请求时会出现，属于预期行为
            pass

    def _handle_post(self) -> None:
        state: MockState = self.server.state  # type: ignore[attr-defined]
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path
        parts = [p for p in path.split("/") if p]
        channel = parts[0] if parts else ""

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b""
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except (json.JSONDecodeError, UnicodeDecodeError):
            body = {}

        auth = self.headers.get("Authorization", "")
        if auth.lower().startswith("bearer "):
            key = auth[7:].strip()
        else:
            key = (
                self.headers.get("x-api-key")
                or self.headers.get("x-goog-api-key")
                or ""
            ).strip()

        is_gemini = ":generateContent" in path or ":streamGenerateContent" in path
        is_anthropic = path.endswith("/v1/messages")
        is_embedding = path.endswith("/v1/embeddings")
        is_completion = path.endswith("/v1/completions")
        is_chat = path.endswith("/v1/chat/completions")

        model = str(body.get("model") or "")
        if is_gemini:
            match = re.search(r"/models/([^:]+):", path)
            if match:
                model = urllib.parse.unquote(match.group(1))
        stream = False
        if is_gemini:
            stream = ":streamGenerateContent" in path
        else:
            stream = bool(body.get("stream"))

        prompt = extract_prompt(body)
        failure = state.failure_status(channel, key, prompt)
        if failure:
            state.record(channel, model, key, failure, stream)
            headers = {}
            if failure == 429:
                headers["Retry-After"] = "7"
            data = json.dumps(
                {
                    "error": {
                        "message": failure_message(failure),
                        "type": "upstream_error",
                        "code": failure,
                    }
                },
                ensure_ascii=False,
            ).encode("utf-8")
            self.send_response(failure)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            for k, v in headers.items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)
            self.close_connection = True
            return

        if is_embedding:
            state.record(channel, model, key, 200, False)
            time.sleep(random.uniform(0.01, 0.04))
            self._send_json(
                200,
                {
                    "object": "list",
                    "data": [
                        {
                            "object": "embedding",
                            "index": 0,
                            "embedding": [round(random.uniform(-0.1, 0.1), 6) for _ in range(16)],
                        }
                    ],
                    "model": model,
                    "usage": {"prompt_tokens": 42, "total_tokens": 42},
                },
            )
            return

        if is_completion and not is_chat:
            state.record(channel, model, key, 200, False)
            time.sleep(random.uniform(0.02, 0.06))
            text = demo_text(channel, model, prompt)
            usage = make_usage(model, prompt, text, "", False)
            self._send_json(
                200,
                {
                    "id": "cmpl-demo-" + hashlib.md5(prompt.encode()).hexdigest()[:12],
                    "object": "text_completion",
                    "created": int(time.time()),
                    "model": model,
                    "choices": [
                        {"text": text, "index": 0, "logprobs": None, "finish_reason": "stop"}
                    ],
                    "usage": usage,
                },
            )
            return

        if not (is_chat or is_anthropic or is_gemini):
            state.record(channel, model, key, 404, stream)
            self._send_json(404, {"error": {"message": "demo upstream: unsupported path " + path}})
            return

        reasoning = ""
        if (
            "trigger-reasoning" in prompt
            or "reasoner" in model
            or "thinking" in prompt
            or "思考" in prompt
        ):
            reasoning = demo_reasoning(model)
        text = demo_text(channel, model, prompt)
        usage = make_usage(model, prompt, text, reasoning, "trigger-heavy" in prompt)
        broken = stream and "trigger-stream-break" in prompt
        slow = stream and "trigger-slow-stream" in prompt

        state.record(channel, model, key, 200, stream)

        if not stream:
            time.sleep(random.uniform(0.02, 0.08))
            if is_anthropic:
                self._send_json(200, self._anthropic_response(model, text, reasoning, usage))
            elif is_gemini:
                self._send_json(200, self._gemini_response(model, text, reasoning, usage))
            else:
                self._send_json(200, self._openai_response(model, text, reasoning, usage))
            return

        # 流式：先延迟一点，让首字耗时看起来真实
        time.sleep(random.uniform(0.06, 0.16))
        self._send_sse_headers(broken=broken)
        if is_anthropic:
            self._anthropic_stream(model, text, reasoning, usage, broken, slow)
        elif is_gemini:
            self._gemini_stream(model, text, reasoning, usage, broken, slow)
        else:
            self._openai_stream(model, text, reasoning, usage, broken, slow)

    # ---- 非流式响应 ----

    @staticmethod
    def _openai_response(
        model: str, text: str, reasoning: str, usage: dict[str, Any]
    ) -> dict[str, Any]:
        message: dict[str, Any] = {"role": "assistant", "content": text}
        if reasoning:
            message["reasoning_content"] = reasoning
        return {
            "id": "chatcmpl-demo-" + hashlib.md5((model + text).encode()).hexdigest()[:12],
            "object": "chat.completion",
            "created": int(time.time()),
            "model": model,
            "choices": [
                {"index": 0, "message": message, "finish_reason": "stop"}
            ],
            "usage": usage,
        }

    @staticmethod
    def _anthropic_response(
        model: str, text: str, reasoning: str, usage: dict[str, Any]
    ) -> dict[str, Any]:
        content = []
        if reasoning:
            content.append({"type": "thinking", "thinking": reasoning, "signature": "demo"})
        content.append({"type": "text", "text": text})
        prompt = int(usage["prompt_tokens"])
        cached = int(usage["prompt_tokens_details"]["cached_tokens"])
        return {
            "id": "msg_demo_" + hashlib.md5((model + text).encode()).hexdigest()[:12],
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": content,
            "stop_reason": "end_turn",
            "stop_sequence": None,
            "usage": {
                "input_tokens": max(0, prompt - cached),
                "output_tokens": int(usage["completion_tokens"]),
                "cache_read_input_tokens": cached,
                "cache_creation_input_tokens": 0,
            },
        }

    @staticmethod
    def _gemini_response(
        model: str, text: str, reasoning: str, usage: dict[str, Any]
    ) -> dict[str, Any]:
        parts = []
        if reasoning:
            parts.append({"text": reasoning, "thought": True})
        parts.append({"text": text})
        return {
            "candidates": [
                {
                    "content": {"role": "model", "parts": parts},
                    "finishReason": "STOP",
                    "index": 0,
                }
            ],
            "usageMetadata": {
                "promptTokenCount": int(usage["prompt_tokens"]),
                "candidatesTokenCount": int(usage["completion_tokens"]),
                "totalTokenCount": int(usage["total_tokens"]),
                "thoughtsTokenCount": int(
                    usage["completion_tokens_details"]["reasoning_tokens"]
                ),
                "cachedContentTokenCount": int(
                    usage["prompt_tokens_details"]["cached_tokens"]
                ),
            },
            "modelVersion": model,
        }

    # ---- 流式响应 ----

    def _openai_stream(
        self,
        model: str,
        text: str,
        reasoning: str,
        usage: dict[str, Any],
        broken: bool,
        slow: bool,
    ) -> None:
        chunk_id = "chatcmpl-demo-" + hashlib.md5((model + text).encode()).hexdigest()[:12]
        created = int(time.time())

        def send(delta: dict[str, Any], finish: Any = None, with_usage: bool = False) -> None:
            payload: dict[str, Any] = {
                "id": chunk_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
            }
            if with_usage:
                payload["usage"] = usage
            self._write_sse(
                ("data: " + json.dumps(payload, ensure_ascii=False) + "\n\n").encode("utf-8")
            )
            # 正常流式也给一点点块间延迟，让「总耗时 > 首字耗时」，
            # 否则本地假上游太快，日志里的速度和首字看起来不真实。
            time.sleep(0.18 if slow else 0.02)

        send({"role": "assistant", "content": ""})
        if broken:
            send({"content": "演示内容开始输出，但上游马上会断开。"})
            return
        if reasoning:
            for piece in split_text(reasoning, 4):
                send({"reasoning_content": piece})
        for piece in split_text(text, 6):
            send({"content": piece})
        send({}, finish="stop", with_usage=True)
        self._write_sse(b"data: [DONE]\n\n")

    def _anthropic_stream(
        self,
        model: str,
        text: str,
        reasoning: str,
        usage: dict[str, Any],
        broken: bool,
        slow: bool,
    ) -> None:
        msg_id = "msg_demo_" + hashlib.md5((model + text).encode()).hexdigest()[:12]
        prompt = int(usage["prompt_tokens"])
        cached = int(usage["prompt_tokens_details"]["cached_tokens"])

        def send(event: str, payload: dict[str, Any]) -> None:
            self._write_sse(
                (
                    "event: " + event + "\n"
                    + "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"
                ).encode("utf-8")
            )
            # 正常流式也给一点点块间延迟，让「总耗时 > 首字耗时」，
            # 否则本地假上游太快，日志里的速度和首字看起来不真实。
            time.sleep(0.18 if slow else 0.02)

        send(
            "message_start",
            {
                "type": "message_start",
                "message": {
                    "id": msg_id,
                    "type": "message",
                    "role": "assistant",
                    "model": model,
                    "content": [],
                    "stop_reason": None,
                    "stop_sequence": None,
                    "usage": {
                        "input_tokens": max(0, prompt - cached),
                        "output_tokens": 0,
                        "cache_read_input_tokens": cached,
                        "cache_creation_input_tokens": 0,
                    },
                },
            },
        )
        index = 0
        if reasoning:
            send(
                "content_block_start",
                {
                    "type": "content_block_start",
                    "index": index,
                    "content_block": {"type": "thinking", "thinking": ""},
                },
            )
            for piece in split_text(reasoning, 3):
                send(
                    "content_block_delta",
                    {
                        "type": "content_block_delta",
                        "index": index,
                        "delta": {"type": "thinking_delta", "thinking": piece},
                    },
                )
            send(
                "content_block_stop",
                {"type": "content_block_stop", "index": index},
            )
            index += 1
        send(
            "content_block_start",
            {
                "type": "content_block_start",
                "index": index,
                "content_block": {"type": "text", "text": ""},
            },
        )
        if broken:
            send(
                "content_block_delta",
                {
                    "type": "content_block_delta",
                    "index": index,
                    "delta": {"type": "text_delta", "text": "上游只输出到这里就断开了。"},
                },
            )
            return
        for piece in split_text(text, 5):
            send(
                "content_block_delta",
                {
                    "type": "content_block_delta",
                    "index": index,
                    "delta": {"type": "text_delta", "text": piece},
                },
            )
        send(
            "content_block_stop",
            {"type": "content_block_stop", "index": index},
        )
        send(
            "message_delta",
            {
                "type": "message_delta",
                "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                "usage": {"output_tokens": int(usage["completion_tokens"])},
            },
        )
        send("message_stop", {"type": "message_stop"})

    def _gemini_stream(
        self,
        model: str,
        text: str,
        reasoning: str,
        usage: dict[str, Any],
        broken: bool,
        slow: bool,
    ) -> None:
        def send(obj: dict[str, Any]) -> None:
            self._write_sse(
                ("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode("utf-8")
            )
            # 正常流式也给一点点块间延迟，让「总耗时 > 首字耗时」，
            # 否则本地假上游太快，日志里的速度和首字看起来不真实。
            time.sleep(0.18 if slow else 0.02)

        if reasoning:
            for piece in split_text(reasoning, 3):
                send(
                    {
                        "candidates": [
                            {
                                "content": {
                                    "role": "model",
                                    "parts": [{"text": piece, "thought": True}],
                                },
                                "index": 0,
                            }
                        ],
                        "modelVersion": model,
                    }
                )
        if broken:
            send(
                {
                    "candidates": [
                        {
                            "content": {
                                "role": "model",
                                "parts": [{"text": "Gemini 演示流在这里中断。"}],
                            },
                            "index": 0,
                        }
                    ],
                    "modelVersion": model,
                }
            )
            return
        pieces = split_text(text, 4)
        for i, piece in enumerate(pieces):
            payload: dict[str, Any] = {
                "candidates": [
                    {
                        "content": {"role": "model", "parts": [{"text": piece}]},
                        "index": 0,
                    }
                ],
                "modelVersion": model,
            }
            if i == len(pieces) - 1:
                payload["candidates"][0]["finishReason"] = "STOP"
                payload["usageMetadata"] = {
                    "promptTokenCount": int(usage["prompt_tokens"]),
                    "candidatesTokenCount": int(usage["completion_tokens"]),
                    "totalTokenCount": int(usage["total_tokens"]),
                    "thoughtsTokenCount": int(
                        usage["completion_tokens_details"]["reasoning_tokens"]
                    ),
                    "cachedContentTokenCount": int(
                        usage["prompt_tokens_details"]["cached_tokens"]
                    ),
                }
            send(payload)


class MockUpstream:
    def __init__(self) -> None:
        self.port = free_port()
        self.state = MockState()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", self.port), MockHandler)
        self.httpd.daemon_threads = True
        self.httpd.state = self.state  # type: ignore[attr-defined]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=3)


# ---------------------------------------------------------------------------
# 演示数据定义
# ---------------------------------------------------------------------------


def caps(
    context_length: int | None = None,
    max_output: int | None = None,
    tool_calling: bool | None = None,
    thinking: bool | None = None,
    vision: bool | None = None,
) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if context_length is not None:
        out["context_length"] = context_length
    if max_output is not None:
        out["max_output"] = max_output
    if tool_calling is not None:
        out["tool_calling"] = tool_calling
    if thinking is not None:
        out["thinking"] = thinking
    if vision is not None:
        out["vision"] = vision
    return out


CHANNELS: list[dict[str, Any]] = [
    {
        "id": "demo-main",
        "name": "OpenAI 主线路",
        "type": "openai",
        "keys": [(MAIN_KEY, "主 Key")],
        "key_mode": "sequential",
        "key_affinity": False,
        "key_cooldown_sec": 1,
        "key_cooldown_reset": True,
        "append_v1": True,
        "models": ["gpt-4o", "gpt-4o-mini", "text-embedding-3-large"],
        "enabled": True,
        "weight": 100,
        "remark": "单 Key 稳定主力线路",
    },
    {
        "id": "demo-bulk",
        "name": "OpenAI 多 Key（顺序）",
        "type": "openai",
        "keys": [
            (BULK_KEYS[0], "已过期 Key"),
            (BULK_KEYS[1], "触发限流的 Key"),
            (BULK_KEYS[2], "可用备用 Key"),
        ],
        "key_mode": "sequential",
        "key_affinity": False,
        "key_cooldown_sec": 1,
        "key_cooldown_reset": True,
        "append_v1": True,
        "models": ["gpt-4o-mini"],
        "enabled": True,
        "weight": 60,
        "remark": "顺序重试：401 → 429 → 成功",
    },
    {
        "id": "demo-random",
        "name": "OpenAI 多 Key（随机）",
        "type": "openai",
        "keys": [
            (RANDOM_KEYS[0], "随机 Key A"),
            (RANDOM_KEYS[1], "随机 Key B"),
            (RANDOM_KEYS[2], "随机 Key C"),
        ],
        "key_mode": "random",
        "key_affinity": False,
        "key_cooldown_sec": 1,
        "key_cooldown_reset": True,
        "append_v1": True,
        "models": ["gpt-4o-mini", "qwen-plus"],
        "enabled": True,
        "weight": 70,
        "remark": "每次请求完整洗牌，再依次尝试",
    },
    {
        "id": "demo-deepseek",
        "name": "DeepSeek 多 Key（顺序 + 亲和）",
        "type": "openai",
        "keys": [
            (DEEPSEEK_KEYS[0], "已过期 Key"),
            (DEEPSEEK_KEYS[1], "主力 Key"),
            (DEEPSEEK_KEYS[2], "备用 Key"),
        ],
        "key_mode": "sequential",
        "key_affinity": True,
        "key_cooldown_sec": 1,
        "key_cooldown_reset": True,
        "append_v1": True,
        "models": ["deepseek-chat", "deepseek-reasoner"],
        "enabled": True,
        "weight": 80,
        "remark": "坏 Key 跳过后，下次从成功的 Key 开始",
    },
    {
        "id": "demo-anthropic",
        "name": "Anthropic 官方",
        "type": "anthropic",
        "keys": [(ANTHROPIC_KEY, "Anthropic Key")],
        "key_mode": "sequential",
        "key_affinity": False,
        "key_cooldown_sec": 1,
        "key_cooldown_reset": True,
        "append_v1": True,
        "models": ["claude-sonnet-4-5", "claude-haiku-4-5"],
        "enabled": True,
        "weight": 90,
        "remark": "Anthropic 原生协议转换",
    },
    {
        "id": "demo-gemini",
        "name": "Google Gemini",
        "type": "gemini",
        "keys": [(GEMINI_KEY, "Gemini Key")],
        "key_mode": "sequential",
        "key_affinity": False,
        "key_cooldown_sec": 1,
        "key_cooldown_reset": True,
        "append_v1": False,
        "models": ["gemini-2.5-flash", "gemini-2.5-pro"],
        "enabled": True,
        "weight": 90,
        "remark": "Gemini /v1beta 路径，不补 /v1",
    },
    {
        "id": "demo-revoked",
        "name": "失效 Key 演示渠道",
        "type": "openai",
        "keys": [(REVOKED_KEY, "固定 401")],
        "key_mode": "sequential",
        "key_affinity": False,
        "key_cooldown_sec": 1,
        "key_cooldown_reset": True,
        "append_v1": True,
        "models": ["gpt-4o-mini"],
        "enabled": True,
        "weight": 10,
        "remark": "上游固定返回 401，用于错误日志演示",
    },
    {
        "id": "demo-ratelimit",
        "name": "限流上游演示渠道",
        "type": "openai",
        "keys": [(RATELIMIT_KEY, "固定 429")],
        "key_mode": "sequential",
        "key_affinity": False,
        "key_cooldown_sec": 1,
        "key_cooldown_reset": True,
        "append_v1": True,
        "models": ["gpt-4o-mini"],
        "enabled": True,
        "weight": 10,
        "remark": "上游固定返回 429，用于限流转移演示",
    },
    {
        "id": "demo-broken",
        "name": "故障上游演示渠道",
        "type": "openai",
        "keys": [(BROKEN_KEY, "固定 500")],
        "key_mode": "sequential",
        "key_affinity": False,
        "key_cooldown_sec": 1,
        "key_cooldown_reset": True,
        "append_v1": True,
        "models": ["gpt-4o-mini", "demo-cooldown", "demo-cooldown-reset"],
        "enabled": True,
        "weight": 10,
        "remark": "上游固定返回 500，用于渠道故障转移与冷却演示",
    },
    {
        "id": "demo-legacy",
        "name": "已停用的历史渠道",
        "type": "openai",
        "keys": [(LEGACY_KEY, "旧 Key")],
        "key_mode": "sequential",
        "key_affinity": False,
        "key_cooldown_sec": 1,
        "key_cooldown_reset": True,
        "append_v1": True,
        "models": ["gpt-4o-legacy"],
        "enabled": False,
        "weight": 1,
        "remark": "渠道已禁用，模型广场显示为渠道已禁用",
    },
]

# (渠道, 上游模型, 显示名, 描述, 标签, caps, provider_id, timeout)
CHANNEL_MODELS: list[tuple[Any, ...]] = [
    (
        "demo-main",
        "gpt-4o",
        "GPT-4o",
        "OpenAI 旗舰多模态对话模型，适合复杂任务与工具调用。",
        ["对话", "多模态", "旗舰"],
        caps(128000, 16384, True, False, True),
        "openai",
        120,
    ),
    (
        "demo-main",
        "gpt-4o-mini",
        "GPT-4o mini",
        "低成本高吞吐的日常对话模型，适合大批量请求。",
        ["对话", "低成本", "高吞吐"],
        caps(128000, 16384, True, False, True),
        "openai",
        90,
    ),
    (
        "demo-main",
        "text-embedding-3-large",
        "Text Embedding 3 Large",
        "OpenAI 文本向量模型，适合检索、聚类与语义搜索。",
        ["嵌入", "检索"],
        caps(8191, None, False, False, False),
        "openai",
        60,
    ),
    (
        "demo-bulk",
        "gpt-4o-mini",
        "GPT-4o mini · 多 Key",
        "顺序 Key 调度演示：坏 Key 自动跳过并继续尝试。",
        ["多 Key", "顺序", "重试"],
        caps(128000, 16384, True, False, True),
        "openai",
        90,
    ),
    (
        "demo-random",
        "gpt-4o-mini",
        "GPT-4o mini · 随机 Key",
        "随机 Key 调度演示：每次请求完整洗牌后依次尝试。",
        ["多 Key", "随机"],
        caps(128000, 16384, True, False, True),
        "openai",
        90,
    ),
    (
        "demo-random",
        "qwen-plus",
        "Qwen Plus",
        "通义千问通用对话模型，中文场景表现稳定。",
        ["对话", "国产", "中文"],
        caps(131072, 8192, True, False, False),
        "alibaba",
        90,
    ),
    (
        "demo-deepseek",
        "deepseek-chat",
        "DeepSeek Chat",
        "高性价比通用对话模型，适合日常问答与写作。",
        ["对话", "高性价比"],
        caps(65536, 8192, True, False, False),
        "deepseek",
        90,
    ),
    (
        "demo-deepseek",
        "deepseek-reasoner",
        "DeepSeek Reasoner",
        "带思考过程的中文推理模型，日志会记录思考字符与 token。",
        ["推理", "思考", "高性价比"],
        caps(65536, 32768, False, True, False),
        "deepseek",
        180,
    ),
    (
        "demo-anthropic",
        "claude-sonnet-4-5",
        "Claude Sonnet 4.5",
        "Anthropic 长上下文多模态模型，适合复杂分析与代码任务。",
        ["对话", "长上下文", "推理"],
        caps(200000, 64000, True, True, True),
        "claude",
        180,
    ),
    (
        "demo-anthropic",
        "claude-haiku-4-5",
        "Claude Haiku 4.5",
        "快速低成本的 Claude 模型，适合高频轻量任务。",
        ["对话", "快速", "低成本"],
        caps(200000, 32000, True, True, True),
        "claude",
        90,
    ),
    (
        "demo-gemini",
        "gemini-2.5-flash",
        "Gemini 2.5 Flash",
        "Google 高速多模态模型，支持超长上下文。",
        ["多模态", "长上下文", "快速"],
        caps(1048576, 65536, True, True, True),
        "gemini",
        120,
    ),
    (
        "demo-gemini",
        "gemini-2.5-pro",
        "Gemini 2.5 Pro",
        "Google 旗舰推理模型，适合复杂多模态任务。",
        ["旗舰", "推理", "长上下文"],
        caps(1048576, 65536, True, True, True),
        "gemini",
        180,
    ),
    (
        "demo-legacy",
        "gpt-4o-legacy",
        "GPT-4o Legacy",
        "挂在已停用渠道上的历史模型，用于展示渠道禁用状态。",
        ["历史", "不可用"],
        caps(128000, 16384, True, False, True),
        "openai",
        90,
    ),
    (
        "demo-main",
        "removed-model",
        "已移除的渠道模型",
        "渠道模型列表里已经删掉，但仍留在模型设置中，展示「渠道模型不存在」。",
        ["已移除", "不可用"],
        caps(128000, 8192, True, False, False),
        "openai",
        30,
    ),
    (
        "demo-missing-channel",
        "ghost-model",
        "渠道已删除的残留模型",
        "引用的渠道本身已经不存在，展示「渠道不存在」状态。",
        ["已删除", "不可用"],
        caps(64000, 4096, False, False, False),
        "openai",
        30,
    ),
    (
        "demo-broken",
        "gpt-4o-mini",
        "故障上游 · GPT-4o mini",
        "模拟持续 500 的上游，用于演示渠道失败与故障转移。",
        ["故障", "演示"],
        caps(128000, 16384, True, False, True),
        "openai",
        30,
    ),
    (
        "demo-broken",
        "demo-cooldown",
        "冷却演示路由",
        "故意持续失败，用于演示路由冷却与全部冷却提示。",
        ["冷却", "演示"],
        caps(128000, 8192, False, False, False),
        "openai",
        30,
    ),
    (
        "demo-broken",
        "demo-cooldown-reset",
        "冷却重置演示路由",
        "全部路由冷却且开启自动重置时，会清空冷却再试一轮。",
        ["冷却", "自动恢复"],
        caps(128000, 8192, False, False, False),
        "openai",
        30,
    ),
    (
        "demo-revoked",
        "gpt-4o-mini",
        "失效 Key 演示",
        "上游固定返回 401，用于展示最终失败日志与原始错误透传。",
        ["401", "错误演示"],
        caps(128000, 8192, False, False, False),
        "openai",
        30,
    ),
    (
        "demo-ratelimit",
        "gpt-4o-mini",
        "限流上游演示",
        "上游固定返回 429，用于展示限流后的渠道转移。",
        ["429", "限流", "重试"],
        caps(128000, 8192, False, False, False),
        "openai",
        30,
    ),
]

CUSTOM_MODELS: list[dict[str, Any]] = [
    {
        "id": "chat-default",
        "display_name": "智能对话（默认）",
        "description": "第一组按 70/30 加权随机，失败后自动切到第二组备用渠道。",
        "tags": ["对话", "加权路由", "多渠道路由"],
        "caps": caps(131072, 16384, True, False, True),
        "provider_id": "openai",
        "routes": [
            {"channel_id": "demo-main", "upstream": "gpt-4o", "weight": 70, "group": 1},
            {"channel_id": "demo-random", "upstream": "gpt-4o-mini", "weight": 30, "group": 1},
            {"channel_id": "demo-anthropic", "upstream": "claude-haiku-4-5", "weight": 100, "group": 2},
        ],
        "affinity": False,
        "cooldown_sec": 30,
        "cooldown_reset": True,
        "timeout": 120,
    },
    {
        "id": "chat-fast",
        "display_name": "极速对话",
        "description": "低延迟优先：随机 Key 与 DeepSeek 组成第一梯队，主线路兜底。",
        "tags": ["对话", "低延迟", "随机 Key"],
        "caps": caps(131072, 8192, True, False, False),
        "provider_id": "deepseek",
        "routes": [
            {"channel_id": "demo-random", "upstream": "gpt-4o-mini", "weight": 60, "group": 1},
            {"channel_id": "demo-deepseek", "upstream": "deepseek-chat", "weight": 40, "group": 1},
            {"channel_id": "demo-main", "upstream": "gpt-4o-mini", "weight": 100, "group": 2},
        ],
        "affinity": False,
        "cooldown_sec": 20,
        "cooldown_reset": True,
        "timeout": 90,
    },
    {
        "id": "chat-affinity",
        "display_name": "亲和路由演示",
        "description": "开启模型亲和：上次成功的路由会在下一次请求中优先尝试。",
        "tags": ["亲和", "演示"],
        "caps": caps(131072, 8192, True, False, False),
        "provider_id": "openai",
        "routes": [
            {"channel_id": "demo-main", "upstream": "gpt-4o-mini", "weight": 50, "group": 1},
            {"channel_id": "demo-deepseek", "upstream": "deepseek-chat", "weight": 50, "group": 1},
        ],
        "affinity": True,
        "cooldown_sec": 20,
        "cooldown_reset": False,
        "timeout": 90,
    },
    {
        "id": "reasoning-pro",
        "display_name": "深度推理 Pro",
        "description": "优先使用带思考过程的推理模型，并记录思考字符与思考 token。",
        "tags": ["推理", "思考", "长上下文"],
        "caps": caps(200000, 64000, True, True, True),
        "provider_id": "deepseek",
        "routes": [
            {"channel_id": "demo-deepseek", "upstream": "deepseek-reasoner", "weight": 60, "group": 1},
            {"channel_id": "demo-anthropic", "upstream": "claude-sonnet-4-5", "weight": 40, "group": 1},
        ],
        "affinity": True,
        "cooldown_sec": 30,
        "cooldown_reset": True,
        "timeout": 180,
    },
    {
        "id": "chat-chain-retry",
        "display_name": "渠道 + Key 双层重试",
        "description": "先跨渠道故障转移，再在同一渠道内轮换 Key，日志可展开完整重试链。",
        "tags": ["重试", "渠道故障转移", "多 Key"],
        "caps": caps(128000, 8192, True, False, False),
        "provider_id": "openai",
        "routes": [
            {"channel_id": "demo-broken", "upstream": "gpt-4o-mini", "weight": 100, "group": 1},
            {"channel_id": "demo-bulk", "upstream": "gpt-4o-mini", "weight": 100, "group": 2},
        ],
        "affinity": False,
        "cooldown_sec": 1,
        "cooldown_reset": True,
        "timeout": 60,
    },
    {
        "id": "chat-key-retry",
        "display_name": "多 Key 顺序重试",
        "description": "同一渠道内按顺序尝试 Key：401、429 后落到可用 Key。",
        "tags": ["多 Key", "顺序", "重试"],
        "caps": caps(128000, 8192, True, False, False),
        "provider_id": "openai",
        "routes": [
            {"channel_id": "demo-bulk", "upstream": "gpt-4o-mini", "weight": 100, "group": 1},
        ],
        "affinity": False,
        "cooldown_sec": 1,
        "cooldown_reset": True,
        "timeout": 60,
    },
    {
        "id": "chat-limit-retry",
        "display_name": "限流自动转移",
        "description": "上游 429 时自动切换下一条路由，日志保留 429 尝试明细。",
        "tags": ["429", "限流", "故障转移"],
        "caps": caps(128000, 8192, True, False, False),
        "provider_id": "openai",
        "routes": [
            {"channel_id": "demo-ratelimit", "upstream": "gpt-4o-mini", "weight": 100, "group": 1},
            {"channel_id": "demo-main", "upstream": "gpt-4o-mini", "weight": 100, "group": 2},
        ],
        "affinity": False,
        "cooldown_sec": 1,
        "cooldown_reset": True,
        "timeout": 60,
    },
    {
        "id": "chat-cooldown",
        "display_name": "路由冷却演示",
        "description": "第一次失败后路由进入冷却，再次调用直接返回全部路由冷却。",
        "tags": ["冷却", "失败"],
        "caps": caps(128000, 8192, False, False, False),
        "provider_id": "openai",
        "routes": [
            {"channel_id": "demo-broken", "upstream": "demo-cooldown", "weight": 100, "group": 1},
        ],
        "affinity": False,
        "cooldown_sec": 600,
        "cooldown_reset": False,
        "timeout": 30,
    },
    {
        "id": "chat-cooldown-reset",
        "display_name": "冷却自动重置",
        "description": "全部路由冷却且开启自动重置时，会清空冷却再尝试一轮。",
        "tags": ["冷却", "自动恢复"],
        "caps": caps(128000, 8192, False, False, False),
        "provider_id": "openai",
        "routes": [
            {"channel_id": "demo-broken", "upstream": "demo-cooldown-reset", "weight": 100, "group": 1},
        ],
        "affinity": False,
        "cooldown_sec": 600,
        "cooldown_reset": True,
        "timeout": 30,
    },
    {
        "id": "chat-auth-fail",
        "display_name": "上游认证失败",
        "description": "上游固定 401，用于展示错误日志与上游原始错误透传。",
        "tags": ["401", "错误演示"],
        "caps": caps(128000, 8192, False, False, False),
        "provider_id": "openai",
        "routes": [
            {"channel_id": "demo-revoked", "upstream": "gpt-4o-mini", "weight": 100, "group": 1},
        ],
        "affinity": False,
        "cooldown_sec": 600,
        "cooldown_reset": False,
        "timeout": 30,
    },
    {
        "id": "chat-ghost",
        "display_name": "缺失上游模型",
        "description": "路由指向渠道里已不存在的模型，广场会显示不可用。",
        "tags": ["不可用", "路由"],
        "caps": caps(None, None, None, None, None),
        "provider_id": "openai",
        "routes": [
            {"channel_id": "demo-main", "upstream": "missing-model", "weight": 100, "group": 1},
        ],
        "affinity": False,
        "cooldown_sec": 30,
        "cooldown_reset": False,
        "timeout": 30,
    },
    {
        "id": "chat-partial-routes",
        "display_name": "部分路由不可用",
        "description": "整体仍可用，但详情里能看到渠道禁用、模型缺失和正常路由的混合状态。",
        "tags": ["路由状态", "混合", "演示"],
        "caps": caps(128000, 8192, True, False, False),
        "provider_id": "openai",
        "routes": [
            {"channel_id": "demo-main", "upstream": "gpt-4o-mini", "weight": 100, "group": 1},
            {"channel_id": "demo-legacy", "upstream": "gpt-4o-legacy", "weight": 100, "group": 2},
            {"channel_id": "demo-main", "upstream": "missing-model", "weight": 100, "group": 3},
        ],
        "affinity": False,
        "cooldown_sec": 30,
        "cooldown_reset": True,
        "timeout": 60,
    },
    {
        "id": "chat-empty",
        "display_name": "未配置路由",
        "description": "还没有任何路由目标的自定义模型，用于展示不可用状态。",
        "tags": ["不可用", "未配置"],
        "caps": caps(None, None, None, None, None),
        "provider_id": "openai",
        "routes": [],
        "affinity": False,
        "cooldown_sec": 30,
        "cooldown_reset": False,
        "timeout": 30,
    },
    {
        "id": "chat-disabled",
        "display_name": "已停用模型",
        "description": "模型已停用，调用会直接返回不可用。",
        "tags": ["停用", "演示"],
        "caps": caps(128000, 8192, True, False, False),
        "provider_id": "openai",
        "routes": [
            {"channel_id": "demo-main", "upstream": "gpt-4o-mini", "weight": 100, "group": 1},
        ],
        "affinity": False,
        "cooldown_sec": 30,
        "cooldown_reset": False,
        "timeout": 30,
        "enabled": False,
    },
    {
        "id": "my-local-llm",
        "display_name": "演示实验室 · Local LLM",
        "description": "归属自定义提供商的模型，用于展示提供商分组与筛选。",
        "tags": ["自定义提供商", "私有"],
        "caps": caps(32768, 4096, False, False, False),
        "provider_id": "demo-local",
        "routes": [
            {"channel_id": "demo-main", "upstream": "gpt-4o-mini", "weight": 100, "group": 1},
        ],
        "affinity": False,
        "cooldown_sec": 30,
        "cooldown_reset": False,
        "timeout": 60,
    },
]


# ---------------------------------------------------------------------------
# 生成流程
# ---------------------------------------------------------------------------


class DemoBuilder:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.data_dir = Path(tempfile.mkdtemp(prefix="ldmapi-demo-"))
        self.db_path = self.data_dir / "ldmapi.db"
        self.gateway_log = self.data_dir / "gateway.log"
        self.gateway: subprocess.Popen[bytes] | None = None
        self.mock = MockUpstream()
        self.gateway_port = free_port()
        self.base = f"http://127.0.0.1:{self.gateway_port}"
        self.admin = AdminAPI(self.base)
        self.binary: Path | None = None
        self.tokens: dict[str, str] = {}
        self.created: dict[str, int] = {}

    # ---- 生命周期 ----

    def build_binary(self) -> Path:
        if self.args.binary:
            path = Path(self.args.binary).resolve()
            if not path.exists():
                raise FileNotFoundError(f"--binary 指定的文件不存在: {path}")
            return path

        go = shutil.which("go")
        if go:
            out = self.data_dir / ("ldmapi.exe" if os.name == "nt" else "ldmapi")
            print(f"  编译网关: go build -> {out.name}")
            proc = subprocess.run(
                [go, "build", "-trimpath", "-o", str(out), "."],
                cwd=str(PROJECT_ROOT),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            if proc.returncode == 0 and out.exists():
                return out
            print("  编译失败，尝试使用 dist/ 里已有的可执行文件：")
            print("  " + (proc.stdout or "").strip().replace("\n", "\n  "))

        exe = ".exe" if os.name == "nt" else ""
        platform = {
            "nt": "windows",
            "posix": "darwin" if sys.platform == "darwin" else "linux",
        }.get(os.name, "linux")
        arch = "arm64" if os.uname().machine.lower() in ("arm64", "aarch64") else "amd64"
        candidate = PROJECT_ROOT / "dist" / f"ldmapi-{platform}-{arch}{exe}"
        if candidate.exists():
            print(f"  使用已有二进制: {candidate}")
            return candidate
        raise RuntimeError(
            "找不到可用的网关二进制：请安装 Go，或用 --binary 指定 dist/ 里的可执行文件"
        )

    def start_gateway(self) -> None:
        assert self.binary is not None
        self.mock.start()
        print(f"  假上游: {self.mock.base}")
        print(f"  网关:   {self.base}  (数据目录 {self.data_dir})")

        log_file = open(self.gateway_log, "wb")
        creationflags = 0
        if os.name == "nt":
            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        cmd = [
            str(self.binary),
            "-host",
            "127.0.0.1",
            "-port",
            str(self.gateway_port),
            "-data",
            str(self.data_dir),
        ]
        if self.args.admin_password != DEFAULT_PASSWORD:
            # 首次启动时由程序写入指定密码，避免生成出来的库只能用默认密码登录。
            cmd += ["-password", self.args.admin_password]
        self.gateway = subprocess.Popen(
            cmd,
            cwd=str(PROJECT_ROOT),
            stdout=log_file,
            stderr=subprocess.STDOUT,
            creationflags=creationflags,
        )
        self._gateway_log_file = log_file
        try:
            wait_for_http(self.base + "/api/settings", timeout=25)
        except Exception:
            self._dump_gateway_log()
            raise

    def _dump_gateway_log(self) -> None:
        try:
            text = self.gateway_log.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return
        if text.strip():
            print("  ---- 网关日志 ----")
            print("\n".join("  " + line for line in text.splitlines()[-30:]))
            print("  ------------------")

    def stop_gateway(self) -> None:
        if self.gateway and self.gateway.poll() is None:
            # 等最后一次写入落盘，再结束进程。bbolt 每次事务都会 fsync，
            # 即使被强制结束也能恢复到最后一个已提交事务。
            time.sleep(0.6)
            self.gateway.terminate()
            try:
                self.gateway.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.gateway.kill()
                self.gateway.wait(timeout=5)
        try:
            self._gateway_log_file.close()
        except Exception:
            pass

    def cleanup(self) -> None:
        self.stop_gateway()
        try:
            self.mock.stop()
        except Exception:
            pass
        if self.args.keep_temp:
            print(f"  临时目录保留: {self.data_dir}")
        else:
            shutil.rmtree(self.data_dir, ignore_errors=True)

    # ---- 初始化 ----

    def login(self) -> None:
        result = self.admin.post(
            "/api/auth/login", {"password": self.args.admin_password}
        )
        if not result or not result.get("success"):
            raise RuntimeError(f"管理端登录失败: {result}")
        print(f"  管理端登录成功（密码 {self.args.admin_password}）")

    def configure_settings(self) -> None:
        self.admin.put(
            "/api/settings",
            {
                "site_name": "懒大猫 API · 演示环境",
                "site_subtitle": "一次生成的全场景示例数据",
                "theme": "light",
                "primary_color": "#4D6BFE",
                "log_retention_days": 30,
                "allow_origins": "",
            },
        )
        print("  站点设置已写入")

    def create_provider(self) -> None:
        self.admin.post(
            "/api/providers",
            {
                "id": "demo-local",
                "name": "演示实验室",
                "icon": "🧪",
                "color": "#8B5CF6",
                "match": ["local-lab"],
                "sort": 99,
            },
        )
        print("  自定义提供商: 演示实验室")

    def create_channels(self) -> None:
        for ch in CHANNELS:
            payload = {
                "id": ch["id"],
                "name": ch["name"],
                "type": ch["type"],
                "base_url": self.mock.base + "/" + ch["id"],
                "key_rows": [
                    {"key": key, "note": note} for key, note in ch["keys"]
                ],
                "key_mode": ch["key_mode"],
                "key_affinity": ch["key_affinity"],
                "key_cooldown_sec": ch["key_cooldown_sec"],
                "key_cooldown_reset": ch["key_cooldown_reset"],
                "append_v1": ch["append_v1"],
                "models": ch["models"],
                "enabled": ch["enabled"],
                "weight": ch["weight"],
                "remark": ch["remark"],
            }
            self.admin.post("/api/channels", payload)
        self.created["channels"] = len(CHANNELS)
        print(f"  渠道: {len(CHANNELS)} 个")

    def create_channel_models(self) -> None:
        for (
            channel,
            upstream,
            display_name,
            description,
            tags,
            model_caps,
            provider_id,
            timeout,
        ) in CHANNEL_MODELS:
            self.admin.post(
                "/api/models",
                {
                    "id": channel + "/" + upstream,
                    "type": "channel",
                    "channel_id": channel,
                    "upstream": upstream,
                    "provider_id": provider_id,
                    "caps": model_caps,
                    "enabled": True,
                    "display_name": display_name,
                    "description": description,
                    "tags": tags,
                    "timeout": timeout,
                },
            )
        self.created["channel_models"] = len(CHANNEL_MODELS)
        print(f"  渠道模型: {len(CHANNEL_MODELS)} 个")

    def create_custom_models(self) -> None:
        for item in CUSTOM_MODELS:
            payload = {
                "id": item["id"],
                "type": "custom",
                "routes": item["routes"],
                "provider_id": item["provider_id"],
                "caps": item["caps"],
                "enabled": item.get("enabled", True),
                "display_name": item["display_name"],
                "description": item["description"],
                "tags": item["tags"],
                "affinity": item["affinity"],
                "cooldown_sec": item["cooldown_sec"],
                "cooldown_reset": item["cooldown_reset"],
                "timeout": item["timeout"],
            }
            self.admin.post("/api/models", payload)
        self.created["custom_models"] = len(CUSTOM_MODELS)
        print(f"  自定义模型: {len(CUSTOM_MODELS)} 个")

    def create_tokens(self) -> None:
        existing = self.admin.get("/api/tokens") or []
        if not existing:
            raise RuntimeError("网关没有创建默认令牌，无法继续")

        main = existing[0]
        now_ms = int(time.time() * 1000)
        self.admin.put(
            f"/api/tokens/{main['id']}",
            {
                "id": main["id"],
                "name": "演示主密钥",
                "enabled": True,
                "expires_at": 0,
                "quota_limit": 50_000_000,
                "allowed_models": [],
                "remark": "全模型演示主密钥，日志中的大部分请求都由它发起",
            },
        )
        refreshed = self.admin.get("/api/tokens") or []
        main_key = next(t["key"] for t in refreshed if t["id"] == main["id"])
        self.tokens["main"] = main_key
        self.tokens["main_id"] = main["id"]

        defs = [
            {
                "name": "演示-移动端",
                "enabled": True,
                "expires_at": now_ms + 30 * 86400 * 1000,
                "quota_limit": 20_000_000,
                "allowed_models": [
                    "chat-default",
                    "chat-fast",
                    "reasoning-pro",
                    "demo-gemini/gemini-2.5-flash",
                ],
                "remark": "只允许调用指定模型",
            },
            {
                "name": "演示-试用额度",
                "enabled": True,
                "expires_at": now_ms + 30 * 86400 * 1000,
                "quota_limit": 300_000,
                "allowed_models": [],
                "remark": "30 天后过期，额度较小",
            },
            {
                "name": "演示-已过期",
                "enabled": True,
                "expires_at": now_ms - 7 * 86400 * 1000,
                "quota_limit": 0,
                "allowed_models": [],
                "remark": "过期后统一返回无效密钥",
            },
            {
                "name": "演示-已禁用",
                "enabled": False,
                "expires_at": 0,
                "quota_limit": 0,
                "allowed_models": [],
                "remark": "手动禁用，调用会被拒绝",
            },
            {
                "name": "演示-额度耗尽",
                "enabled": True,
                "expires_at": 0,
                "quota_limit": 1000,
                "allowed_models": [],
                "remark": "用于展示额度进度与额度不足提示",
            },
            {
                "name": "演示-仅嵌入",
                "enabled": True,
                "expires_at": 0,
                "quota_limit": 5_000_000,
                "allowed_models": ["demo-main/text-embedding-3-large"],
                "remark": "只允许嵌入模型",
            },
        ]
        for item in defs:
            created = self.admin.post("/api/tokens", item)
            self.tokens[item["name"]] = created["key"]
        self.created["tokens"] = len(defs) + 1
        print(f"  令牌: {len(defs) + 1} 个")

    # ---- 发起真实调用 ----

    def _relay(
        self,
        path: str,
        payload: dict[str, Any],
        token: str | None = None,
        stream: bool = False,
        xff: str | None = None,
        cancel_after_first: bool = False,
    ) -> tuple[int, bytes]:
        headers: dict[str, str] = {}
        if token:
            headers["Authorization"] = "Bearer " + token
        if xff:
            headers["X-Forwarded-For"] = xff
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(self.base + path, data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        for k, v in headers.items():
            req.add_header(k, v)
        try:
            resp = urllib.request.urlopen(req, timeout=40)
        except urllib.error.HTTPError as e:
            return int(e.code), e.read()
        try:
            if stream:
                try:
                    first = resp.read(16)
                except (ConnectionResetError, http.client.HTTPException, OSError):
                    first = b""
                if cancel_after_first:
                    # 主动取消时 Windows 上 close() 可能抛 10054，属于预期
                    try:
                        resp.close()
                    except Exception:
                        pass
                    return int(resp.status), b"<canceled>"
                try:
                    rest = resp.read()
                except (ConnectionResetError, http.client.HTTPException, OSError):
                    rest = b""
                return int(resp.status), first + rest
            return int(resp.status), resp.read()
        finally:
            try:
                resp.close()
            except Exception:
                pass

    def chat(
        self,
        model: str,
        prompt: str,
        token: str | None = None,
        stream: bool = False,
        xff: str | None = None,
        expect_error: bool = False,
        max_tokens: int | None = None,
    ) -> int:
        payload: dict[str, Any] = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": stream,
        }
        if max_tokens:
            payload["max_tokens"] = max_tokens
        if stream:
            payload["stream_options"] = {"include_usage": True}
        status, _ = self._relay(
            "/v1/chat/completions",
            payload,
            token=token or self.tokens["main"],
            stream=stream,
            xff=xff,
        )
        if status >= 400 and not expect_error:
            print(f"  ! {model} 返回 {status}（未预期）")
        return status

    def cancel_stream(self, model: str, prompt: str, xff: str | None = None) -> int:
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        status, _ = self._relay(
            "/v1/chat/completions",
            payload,
            token=self.tokens["main"],
            stream=True,
            xff=xff,
            cancel_after_first=True,
        )
        return status

    def embeddings(
        self, model: str, text: str, xff: str | None = None, token: str | None = None
    ) -> int:
        status, _ = self._relay(
            "/v1/embeddings",
            {"model": model, "input": text},
            token=token or self.tokens["main"],
            xff=xff,
        )
        return status

    def completion(self, model: str, prompt: str, xff: str | None = None) -> int:
        status, _ = self._relay(
            "/v1/completions",
            {"model": model, "prompt": prompt, "max_tokens": 64},
            token=self.tokens["main"],
            xff=xff,
        )
        return status

    def native_messages(self, model: str, prompt: str, xff: str | None = None) -> int:
        status, _ = self._relay(
            "/v1/messages",
            {
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 256,
            },
            token=self.tokens["main"],
            xff=xff,
        )
        return status

    def online_chat(
        self, model: str, prompt: str, stream: bool, xff: str | None = None
    ) -> int:
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": stream,
        }
        headers = {"X-Forwarded-For": xff} if xff else None
        try:
            resp = self.admin.open_stream("/api/chat", payload, headers=headers)
        except urllib.error.HTTPError as e:
            return int(e.code)
        try:
            if stream:
                resp.read(16)
            resp.read()
            return int(resp.status)
        finally:
            try:
                resp.close()
            except Exception:
                pass

    # ---- 流量编排 ----

    def generate_traffic(self) -> None:
        ip = lambda i: CLIENT_IPS[i % len(CLIENT_IPS)]  # noqa: E731
        print("  生成常规成功日志…")

        # 1) 默认对话模型：加权路由 + 多 Key + 流式
        for i in range(8):
            self.chat(
                "chat-default",
                f"请用一句话介绍懒大猫 API 的第 {i + 1} 个优点。",
                xff=ip(i),
            )
        for i in range(4):
            self.chat(
                "chat-default",
                f"用三点总结模型聚合网关的价值（流式第 {i + 1} 次）。",
                stream=True,
                xff=ip(i + 8),
            )

        # 2) 极速对话：随机 Key + DeepSeek
        for i in range(5):
            self.chat(
                "chat-fast",
                f"给我一个低延迟模型选型的建议 #{i + 1}。",
                xff=ip(i + 2),
            )
        for i in range(2):
            self.chat(
                "chat-fast",
                f"流式输出一段关于多 Key 调度的说明 #{i + 1}。",
                stream=True,
                xff=ip(i + 5),
            )

        # 3) 推理模型：思考内容、思考 token
        for i in range(2):
            self.chat(
                "reasoning-pro",
                f"trigger-reasoning 请分步骤分析：为什么需要模型路由？案例 {i + 1}",
                max_tokens=1024,
                xff=ip(i + 1),
            )
        for i in range(3):
            self.chat(
                "reasoning-pro",
                f"trigger-reasoning 用流式输出你的推理过程，主题 {i + 1}。",
                stream=True,
                max_tokens=1024,
                xff=ip(i + 4),
            )

        # 4) 原生协议渠道
        for i in range(2):
            self.chat(
                "demo-anthropic/claude-sonnet-4-5",
                f"Anthropic 渠道非流式演示 {i + 1}：解释一下亲和路由。",
                xff=ip(i + 6),
            )
        for i in range(2):
            self.chat(
                "demo-anthropic/claude-sonnet-4-5",
                f"Anthropic 渠道流式演示 {i + 1}：讲讲长上下文模型。",
                stream=True,
                xff=ip(i + 7),
            )
        for i in range(2):
            self.chat(
                "demo-gemini/gemini-2.5-flash",
                f"Gemini 流式演示 {i + 1}：用一句话描述多模态能力。",
                stream=True,
                xff=ip(i + 3),
            )
        self.chat(
            "demo-gemini/gemini-2.5-pro",
            "trigger-reasoning Gemini 推理演示：比较 Flash 与 Pro。",
            xff=ip(9),
        )
        self.chat(
            "demo-random/qwen-plus",
            "Qwen Plus 演示：写一句中文欢迎语。",
            xff=ip(10),
        )

        # 5) 非对话端点
        self.embeddings("demo-main/text-embedding-3-large", "懒大猫 API 的语义检索演示")
        self.embeddings(
            "demo-main/text-embedding-3-large",
            "模型聚合网关与路由调度",
            token=self.tokens["演示-仅嵌入"],
        )
        self.completion("demo-main/gpt-4o-mini", "Once upon a time, the gateway")
        self.native_messages(
            "demo-anthropic/claude-haiku-4-5", "原生 /v1/messages 入口演示。"
        )
        self.chat(
            "chat-partial-routes",
            "混合路由状态演示：正常路由仍然可以成功。",
            xff=ip(13),
        )
        self.chat(
            "my-local-llm",
            "自定义提供商模型演示：归属「演示实验室」。",
            xff=ip(14),
        )
        self.chat(
            "demo-main/gpt-4o",
            "渠道模型直接调用演示：单 Key、无 Key 序号。",
            xff=ip(15),
        )

        # 6) 在线聊天（管理端 playground）
        self.online_chat(
            "chat-fast", "在线聊天演示：非流式请求也会写日志。", stream=False, xff=ip(11)
        )
        self.online_chat(
            "chat-fast", "在线聊天演示：流式请求的 token 速度。", stream=True, xff=ip(12)
        )

        # 7) 受限令牌
        self.chat(
            "chat-fast",
            "移动端令牌演示：只允许调用白名单模型。",
            token=self.tokens["演示-移动端"],
            xff="203.0.113.201",
        )
        self.chat(
            "chat-default",
            "移动端令牌演示：默认对话模型。",
            token=self.tokens["演示-移动端"],
            xff="203.0.113.202",
        )
        self.chat(
            "chat-fast",
            "试用额度令牌演示：记录用量进度。",
            token=self.tokens["演示-试用额度"],
            xff="203.0.113.203",
        )

        # 给每个「渠道模型」也各造一条直连日志，模型广场的渠道模型卡片
        # 才不会因为只被自定义模型间接调用而显示「近 24h 0 次」。
        cover_models = [
            "demo-bulk/gpt-4o-mini",
            "demo-random/gpt-4o-mini",
            "demo-deepseek/deepseek-chat",
            "demo-deepseek/deepseek-reasoner",
            "demo-broken/gpt-4o-mini",
            "demo-broken/demo-cooldown",
            "demo-broken/demo-cooldown-reset",
            "demo-revoked/gpt-4o-mini",
            "demo-ratelimit/gpt-4o-mini",
        ]
        for i, model in enumerate(cover_models):
            self.chat(
                model,
                f"渠道模型直连演示 #{i + 1}：{model}",
                expect_error=model.startswith(("demo-broken", "demo-revoked", "demo-ratelimit")),
                xff=ip(20 + i),
            )
        # 直连失败会留下路由/Key 冷却，先清掉，避免影响后面的重试与冷却演示。
        self.admin.post("/api/models/clear-cooldowns", {})
        time.sleep(0.3)

        print("  生成亲和、重试、冷却与错误日志…")

        # 8) 模型亲和：第一次随机，后续命中上次成功的路由
        for i in range(4):
            self.chat(
                "chat-affinity",
                f"亲和路由测试 {i + 1}：同一模型连续请求。",
                xff=ip(i + 4),
            )

        # 9) 同一渠道的 Key 重试：401 → 429 → 成功
        self.chat("chat-key-retry", "Key 顺序重试 #1：坏 Key 会被跳过。")
        # 坏 Key 还在 1 秒冷却内，这次应该直接命中可用 Key（多 Key 一次成功）
        self.chat("chat-key-retry", "Key 顺序重试 #2：坏 Key 冷却中。")
        time.sleep(1.2)
        self.chat("chat-key-retry", "Key 顺序重试 #3：冷却已过，重新走完整链。")

        # 10) 渠道重试后 Key 重试：500 → (401 → 429 → 成功)
        time.sleep(1.2)
        self.chat("chat-chain-retry", "渠道 + Key 双层重试 #1。")
        time.sleep(1.2)
        self.chat("chat-chain-retry", "渠道 + Key 双层重试 #2。")

        # 11) 429 限流转移
        time.sleep(1.2)
        self.chat("chat-limit-retry", "限流自动转移 #1：429 后切渠道。")
        time.sleep(1.2)
        self.chat("chat-limit-retry", "限流自动转移 #2：429 后切渠道。")

        # 12) 冷却与冷却自动重置
        self.chat("chat-cooldown", "冷却演示 #1：上游 500。", expect_error=True)
        self.chat(
            "chat-cooldown",
            "冷却演示 #2：路由还在冷却，应该直接返回全部冷却。",
            expect_error=True,
        )
        self.chat(
            "chat-cooldown-reset",
            "冷却重置 #1：上游 500。",
            expect_error=True,
        )
        self.chat(
            "chat-cooldown-reset",
            "冷却重置 #2：自动清空冷却再试一轮。",
            expect_error=True,
        )

        # 13) 最终失败与不可用
        self.chat("chat-auth-fail", "认证失败演示：上游固定 401。", expect_error=True)
        self.chat("chat-ghost", "缺失模型路由演示。", expect_error=True)
        self.chat("chat-empty", "未配置路由演示。", expect_error=True)
        self.chat("chat-disabled", "已停用模型演示。", expect_error=True)
        self.chat(
            "demo-legacy/gpt-4o-legacy",
            "渠道已禁用演示。",
            expect_error=True,
        )

        # 14) 客户端 400：上游原始错误透传
        self.chat(
            "chat-default",
            "trigger-400 这条请求会被上游判定为参数错误。",
            expect_error=True,
        )

        # 15) 额度耗尽：一次大用量 + 一次额度不足
        quota_token = self.tokens["演示-额度耗尽"]
        self.chat(
            "demo-main/gpt-4o-mini",
            "trigger-heavy 生成一份很大的报告，用于消耗令牌额度。",
            token=quota_token,
            xff="203.0.113.210",
        )
        self.chat(
            "demo-main/gpt-4o-mini",
            "额度已经被耗尽，这次调用应该被拒绝。",
            token=quota_token,
            expect_error=True,
            xff="203.0.113.211",
        )

        # 16) 客户端取消流式请求：黄色 200，记成功
        self.cancel_stream(
            "chat-default",
            "trigger-slow-stream 请慢慢输出，客户端会在中途停止。",
            xff="203.0.113.220",
        )
        time.sleep(0.4)

        # 17) 上游中途断开：红色 200，记错误
        self.chat(
            "chat-default",
            "trigger-stream-break 请输出到一半然后断开。",
            stream=True,
            expect_error=True,
            xff="203.0.113.221",
        )
        # 给网关一点时间写完最后一条日志
        time.sleep(1.0)

        # 18) 失效令牌验证（这些请求在网关鉴权阶段就被拒绝，不会写日志）
        for name in ("演示-已过期", "演示-已禁用"):
            status, _ = self._relay(
                "/v1/chat/completions",
                {
                    "model": "chat-fast",
                    "messages": [{"role": "user", "content": "invalid token test"}],
                },
                token=self.tokens[name],
            )
            if status != 401:
                print(f"  ! {name} 预期 401，实际 {status}")
        status, _ = self._relay(
            "/v1/chat/completions",
            {
                "model": "chat-default",
                "messages": [{"role": "user", "content": "model not allowed"}],
            },
            token=self.tokens["演示-仅嵌入"],
        )
        if status != 403:
            print(f"  ! 演示-仅嵌入 预期 403，实际 {status}")

        print("  调用完成")

    # ---- 校验与收尾 ----

    def verify(self) -> dict[str, Any]:
        logs_payload = self.admin.get("/api/logs?limit=500") or {}
        logs = logs_payload.get("items") or []
        total = int(logs_payload.get("total") or 0)
        models = self.admin.get("/api/models") or []
        plaza = self.admin.get("/api/plaza") or []
        providers = self.admin.get("/api/providers") or []
        tokens = self.admin.get("/api/tokens") or []
        channels = self.admin.get("/api/channels") or []

        attempts_logs = [l for l in logs if len(l.get("attempts") or []) >= 2]
        cross_channel = [
            l
            for l in attempts_logs
            if len({a.get("channel_id") for a in l["attempts"]}) >= 2
        ]
        key_attempts = [
            l
            for l in attempts_logs
            if any(a.get("key_index") for a in l["attempts"])
        ]
        affinity = [l for l in logs if l.get("affinity")]
        canceled = [l for l in logs if l.get("canceled")]
        streams = [l for l in logs if l.get("stream")]
        errors = [
            l
            for l in logs
            if not l.get("canceled")
            and (l.get("status_code", 0) >= 400 or l.get("error"))
        ]
        success = [l for l in logs if l not in errors and not l.get("canceled")]
        status_codes = sorted({l.get("status_code", 0) for l in logs})
        plaza_status = sorted({m.get("status", "") for m in plaza})
        available = sum(1 for m in plaza if m.get("available"))
        caps_count = sum(
            1
            for m in plaza
            if any(
                m.get("caps", {}).get(k) is not None
                for k in ("context_length", "max_output", "tool_calling", "thinking", "vision")
            )
        )

        summary = {
            "logs_total": total,
            "logs_fetched": len(logs),
            "success": len(success),
            "errors": len(errors),
            "canceled": len(canceled),
            "streams": len(streams),
            "retry_logs": len(attempts_logs),
            "cross_channel_retry": len(cross_channel),
            "key_retry": len(key_attempts),
            "affinity_hits": len(affinity),
            "status_codes": status_codes,
            "channels": len(channels),
            "models": len(models),
            "plaza_available": available,
            "plaza_status": plaza_status,
            "providers": len(providers),
            "tokens": len(tokens),
            "models_with_caps": caps_count,
        }

        print()
        print("  ---- 生成结果 ----")
        print(f"  日志: {total} 条（成功 {len(success)} / 失败 {len(errors)} / 取消 {len(canceled)} / 流式 {len(streams)}）")
        print(
            f"  重试: {len(attempts_logs)} 条；跨渠道 {len(cross_channel)} 条；"
            f"含 Key 重试 {len(key_attempts)} 条；亲和命中 {len(affinity)} 条"
        )
        print(f"  状态码: {', '.join(str(x) for x in status_codes)}")
        print(
            f"  渠道 {len(channels)} / 模型 {len(models)} / 令牌 {len(tokens)} / 提供商 {len(providers)}"
        )
        print(f"  模型广场: {available} 个可用，状态 {', '.join(plaza_status)}")
        print(f"  带能力参数的模型: {caps_count} 个")
        print("  ------------------")

        missing = []
        required_statuses = {
            "ok",
            "disabled",
            "channel_disabled",
            "channel_missing",
            "model_missing",
            "no_routes",
            "unavailable",
        }
        missing_statuses = sorted(required_statuses - set(plaza_status))
        for label, cond in [
            ("跨渠道重试", bool(cross_channel)),
            ("多 Key 重试", bool(key_attempts)),
            ("模型亲和命中", bool(affinity)),
            ("客户端取消", bool(canceled)),
            ("流式日志", bool(streams)),
            ("错误日志", bool(errors)),
            ("4xx 状态码", any(code >= 400 for code in status_codes)),
            ("模型广场可用项", available > 0),
            ("能力参数", caps_count > 0),
            (
                "模型状态: " + "、".join(missing_statuses),
                not missing_statuses,
            ),
        ]:
            if not cond:
                missing.append(label)
        if missing:
            print("  ⚠ 未覆盖到的场景: " + "、".join(missing))
            if self.args.strict:
                raise RuntimeError("场景覆盖校验失败: " + "、".join(missing))
        else:
            print("  ✓ 关键场景均已覆盖")
        return summary

    def spread_logs(self) -> None:
        days = int(self.args.spread_days)
        if days <= 0:
            return
        go = shutil.which("go")
        if not go:
            print("  ! 没有找到 Go，跳过日志时间分布")
            return
        print(f"  把日志分布到最近 {days} 天（便于查看看板趋势）…")
        work = Path(tempfile.mkdtemp(prefix="demo_seed_rewrite_", dir=str(PROJECT_ROOT / "scripts")))
        try:
            (work / "main.go").write_text(self._rewrite_source(), encoding="utf-8")
            proc = subprocess.run(
                [
                    go,
                    "run",
                    "./" + work.relative_to(PROJECT_ROOT).as_posix(),
                    str(self.db_path),
                    str(days),
                    str(self.args.seed),
                ],
                cwd=str(PROJECT_ROOT),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            if proc.returncode != 0:
                print("  ! 日志时间分布失败，保留原始时间：")
                print("    " + (proc.stdout or "").strip().replace("\n", "\n    "))
            else:
                out = (proc.stdout or "").strip()
                if out:
                    print("    " + out.replace("\n", "\n    "))
        finally:
            shutil.rmtree(work, ignore_errors=True)

    @staticmethod
    def _rewrite_source() -> str:
        return r'''package main

import (
	"fmt"
	"math/rand"
	"os"
	"sort"
	"strconv"
	"time"

	"ldmapi/internal/store"
)

// 这个临时程序只做一件事：把演示日志的时间重新分布到最近 N 天，
// 并按新的时间重建小时统计桶。它由 gen_demo_data.py 生成并在网关停止后运行。
func main() {
	if len(os.Args) < 4 {
		fmt.Fprintln(os.Stderr, "usage: rewrite <db> <days> <seed>")
		os.Exit(2)
	}
	dbPath := os.Args[1]
	days, _ := strconv.Atoi(os.Args[2])
	seed, _ := strconv.ParseInt(os.Args[3], 10, 64)
	if days <= 0 {
		return
	}

	st, err := store.Open(dbPath)
	if err != nil {
		panic(err)
	}
	defer st.Close()

	n, err := st.CountLogs()
	if err != nil || n == 0 {
		return
	}
	logs, _, err := st.QueryLogs(store.LogFilter{Limit: n + 10})
	if err != nil {
		panic(err)
	}
	// QueryLogs 是最新在前；先按原时间正序，保证重试链的相对顺序不变。
	sort.SliceStable(logs, func(i, j int) bool { return logs[i].Time < logs[j].Time })

	now := time.Now()
	loc := time.FixedZone("CST", 8*3600)
	localNow := now.In(loc)
	today := time.Date(localNow.Year(), localNow.Month(), localNow.Day(), 0, 0, 0, 0, loc)
	rng := rand.New(rand.NewSource(seed))

	// 每个模型至少留一条日志在今天，保证模型广场的「近 24h」不是一片 0。
	mustToday := map[string]int{}
	for i := range logs {
		if logs[i].ModelID != "" {
			mustToday[logs[i].ModelID] = i
		}
	}

	targets := make([]time.Time, len(logs))
	byDay := make([][]int, days)
	for i := range logs {
		dayOffset := 0
		forced := logs[i].ModelID != "" && mustToday[logs[i].ModelID] == i
		if !forced && days > 1 {
			p := 0.45
			if logs[i].Stream {
				p = 0.78
			}
			if !logs[i].Canceled && (logs[i].StatusCode >= 400 || logs[i].Error != "") {
				p = 0.72
			}
			if rng.Float64() >= p {
				dayOffset = 1 + rng.Intn(days-1)
			}
		}
		if dayOffset >= days {
			dayOffset = days - 1
		}
		byDay[dayOffset] = append(byDay[dayOffset], i)
	}

	// 按天分组后再分配具体时刻：同一天的日志保持原有先后顺序，
	// 不同天之间允许交错，这样既能保证每个模型今天至少有一条，
	// 又不会把同一次重试链的顺序打乱。
	for d, idxs := range byDay {
		var start, end time.Time
		if d == 0 {
			start, end = today, localNow
		} else {
			dayStart := today.AddDate(0, 0, -d)
			start = dayStart.Add(9 * time.Hour)
			end = dayStart.Add(21 * time.Hour)
		}
		span := end.Sub(start)
		if span < time.Minute {
			span = time.Minute
		}
		times := make([]time.Time, len(idxs))
		for k := range times {
			times[k] = start.Add(time.Duration(rng.Int63n(int64(span))))
			if d == 0 && times[k].After(localNow) {
				times[k] = localNow
			}
		}
		sort.Slice(times, func(a, b int) bool { return times[a].Before(times[b]) })
		for k, idx := range idxs {
			targets[idx] = times[k]
		}
	}

	future := now.AddDate(1, 0, 0).UnixMilli()
	if _, err := st.PurgeLogsBefore(future); err != nil {
		panic(err)
	}
	if err := st.PurgeStatsBefore(future); err != nil {
		panic(err)
	}
	for i := range logs {
		logs[i].Time = targets[i].UnixMilli()
		if err := st.AppendLog(logs[i]); err != nil {
			panic(err)
		}
		if err := st.RecordStat(logs[i]); err != nil {
			panic(err)
		}
	}
	fmt.Printf("distributed %d logs over %d days\n", len(logs), days)
}
'''

    def export(self) -> Path:
        out = Path(self.args.out).expanduser().resolve()
        if out.exists() and not self.args.force:
            raise FileExistsError(
                f"输出文件已存在: {out}\n如需覆盖请加 --force"
            )
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(self.db_path, out)
        return out

    def run(self) -> None:
        print("懒大猫 API 演示数据库生成器")
        print(f"项目目录: {PROJECT_ROOT}")
        print()
        self.binary = self.build_binary()
        try:
            self.start_gateway()
            self.login()
            self.configure_settings()
            self.create_provider()
            self.create_channels()
            self.create_channel_models()
            self.create_custom_models()
            self.create_tokens()
            self.generate_traffic()
            summary = self.verify()
            self.stop_gateway()
            self.spread_logs()
            out = self.export()
        finally:
            self.cleanup()

        size_mb = out.stat().st_size / 1024 / 1024
        print()
        print("  ✓ 演示数据库已生成")
        print(f"    文件: {out}  ({size_mb:.2f} MB)")
        print(f"    管理密码: {self.args.admin_password}")
        print(f"    主密钥: {self.tokens.get('main', '')}")
        print()
        print("  使用方法：")
        print(f"    1. 把 {out.name} 放到网关的 data 目录（或任意目录）")
        print(f"    2. 启动: ldmapi -data <db 所在目录>")
        print(f"    3. 浏览器打开控制台，用密码 {self.args.admin_password} 登录")
        print()
        print("  说明：亲和与冷却状态保存在内存里，重启后会从空闲状态开始；")
        print("        日志里仍保留亲和命中、冷却失败和重试明细，方便演示。")
        print()
        print("  日志概览：")
        for key, value in summary.items():
            if key in ("status_codes", "plaza_status"):
                value = ", ".join(str(v) for v in value)
            print(f"    {key}: {value}")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="生成一份可直接启动的懒大猫 API 演示数据库。",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--out",
        default=str(DEFAULT_OUT),
        help="输出的 ldmapi.db 路径",
    )
    parser.add_argument(
        "--binary",
        default="",
        help="指定已编译的网关二进制；默认用 go build 从当前源码编译",
    )
    parser.add_argument(
        "--admin-password",
        default=DEFAULT_PASSWORD,
        help="生成库的管理端密码",
    )
    parser.add_argument(
        "--spread-days",
        type=int,
        default=7,
        help="把日志分布到最近 N 天；0 表示保留生成时刻",
    )
    parser.add_argument("--seed", type=int, default=20261019, help="随机种子")
    parser.add_argument("--force", action="store_true", help="覆盖已存在的输出文件")
    parser.add_argument(
        "--strict", action="store_true", help="场景覆盖不全时直接失败"
    )
    parser.add_argument(
        "--keep-temp", action="store_true", help="保留临时数据目录，便于排查"
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    random.seed(args.seed)
    builder = DemoBuilder(args)
    try:
        builder.run()
    except KeyboardInterrupt:
        print("\n已中断")
        return 130
    except Exception as exc:  # noqa: BLE001 - 命令行工具，直接展示原因
        print()
        print(f"生成失败: {exc}")
        if not args.keep_temp:
            print("（可加 --keep-temp 保留临时目录和网关日志）")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
