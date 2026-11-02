#!/usr/bin/env python3
"""A stand-in model API, so the assistant can be tested without a real key or any cost.

Speaks the streaming formats at /v1/messages (Anthropic) and /v1/chat/completions (OpenAI-compatible).
Run it alone with: python3 tests/fake_provider.py --port 8799

What it does with a message:
- If the open file holds \\badcommand, it proposes replacing that with "fixed text".
- If the message says "read file <rel>", it asks to read that file.
- If the message says "slow", it streams slowly for 30 s, so Stop can be tested.
- Otherwise it answers in plain text.
"""
from __future__ import annotations

import argparse
import json
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

THINKING = {"type": "thinking", "thinking": "", "signature": "sig-abc"}


class FakeProvider(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    seen: list = []
    expected_key = None

    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        self.seen.append({"path": self.path, "headers": dict(self.headers), "body": None})
        anthropic = self.headers.get("x-api-key") is not None
        supplied = self.headers.get("x-api-key") if anthropic else (self.headers.get("authorization") or "")[7:]
        if self.expected_key and supplied != self.expected_key:
            return self._reject(supplied)
        if anthropic:
            rows = [{"id": "fake-opus", "display_name": "Fake Opus",
                     "capabilities": {"effort": {"supported": True, "high": {"supported": True},
                                                 "max": {"supported": True}, "xhigh": {"supported": False}}}},
                    {"id": "fake-haiku", "display_name": "Fake Haiku",
                     "capabilities": {"effort": {"supported": False}}},
                    {"id": "fake-plain", "display_name": "Fake Plain"}]
        else:
            rows = [{"id": "fake-old", "created": 1}, {"id": "fake-new", "created": 3},
                    {"id": "fake-new-2026-01-02", "created": 4}, {"id": "fake-embedding-1", "created": 2}]
        self._json(200, {"data": rows, "has_more": False})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.seen.append({"path": self.path, "headers": dict(self.headers), "body": body})
        anthropic = self.path.endswith("/messages")
        supplied = self.headers.get("x-api-key") if anthropic else (self.headers.get("authorization") or "")[7:]
        if self.expected_key and supplied != self.expected_key:
            return self._reject(supplied)
        refusal = refuses(body)
        if refusal:
            return self._json(400, {"error": {"message": refusal}})
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        text, call = decide(body["messages"])
        try:
            if text == "slow":
                self._slow(anthropic)
            elif anthropic:
                self._anthropic(text, call)
            else:
                self._openai(text, call)
        except OSError:
            pass

    def _reject(self, supplied: str | None) -> None:
        # Real providers can repeat part of a rejected key, so the stand-in repeats all of it.
        self._json(401, {"error": {"type": "authentication_error", "message": f"invalid x-api-key {supplied}"}})

    def _json(self, status: int, payload: dict) -> None:
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _event(self, data: dict) -> None:
        self.wfile.write(f"event: {data.get('type', 'message')}\ndata: {json.dumps(data)}\n\n".encode())
        self.wfile.flush()

    def _anthropic(self, text: str, call: dict | None) -> None:
        self._event({"type": "message_start", "message": {"id": "msg_1", "role": "assistant", "content": []}})
        index = 0
        self._event({"type": "content_block_start", "index": index, "content_block": {**THINKING}})
        self._event({"type": "content_block_stop", "index": index})
        index += 1
        self._event({"type": "content_block_start", "index": index, "content_block": {"type": "text", "text": ""}})
        for word in re.findall(r"\S+\s*", text):
            self._event({"type": "content_block_delta", "index": index,
                         "delta": {"type": "text_delta", "text": word}})
        self._event({"type": "content_block_stop", "index": index})
        if call:
            index += 1
            self._event({"type": "content_block_start", "index": index,
                         "content_block": {"type": "tool_use", "id": "toolu_1", "name": call["name"], "input": {}}})
            encoded = json.dumps(call["input"])
            for start in range(0, len(encoded), 20):
                self._event({"type": "content_block_delta", "index": index,
                             "delta": {"type": "input_json_delta", "partial_json": encoded[start:start + 20]}})
            self._event({"type": "content_block_stop", "index": index})
        self._event({"type": "message_delta", "delta": {"stop_reason": "tool_use" if call else "end_turn"}})
        self._event({"type": "message_stop"})

    def _openai(self, text: str, call: dict | None) -> None:
        for word in re.findall(r"\S+\s*", text):
            self._data({"choices": [{"index": 0, "delta": {"content": word}, "finish_reason": None}]})
        if call:
            encoded = json.dumps(call["input"])
            self._data({"choices": [{"index": 0, "delta": {"tool_calls": [
                {"index": 0, "id": "call_1", "type": "function", "function": {"name": call["name"], "arguments": ""}}
            ]}, "finish_reason": None}]})
            for start in range(0, len(encoded), 20):
                self._data({"choices": [{"index": 0, "delta": {"tool_calls": [
                    {"index": 0, "function": {"arguments": encoded[start:start + 20]}}
                ]}, "finish_reason": None}]})
        self._data({"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls" if call else "stop"}]})
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def _data(self, data: dict) -> None:
        self.wfile.write(f"data: {json.dumps(data)}\n\n".encode())
        self.wfile.flush()

    def _slow(self, anthropic: bool) -> None:
        if anthropic:
            self._event({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})
        for number in range(300):
            if anthropic:
                self._event({"type": "content_block_delta", "index": 0,
                             "delta": {"type": "text_delta", "text": f"word{number} "}})
            else:
                self._data({"choices": [{"index": 0, "delta": {"content": f"word{number} "}, "finish_reason": None}]})
            time.sleep(0.1)


def refuses(body: dict) -> str | None:
    """Some model names refuse settings, the way older real models do."""
    model = body.get("model")
    effort = (body.get("output_config") or {}).get("effort") or body.get("reasoning_effort")
    if model == "no-effort" and effort:
        return "effort is not supported on this model"
    if model == "no-max" and effort == "max":
        return "This model does not support effort level max"
    if model == "no-thinking" and "thinking" in body:
        return "thinking is not supported on this model"
    if model == "limit-named" and body.get("max_tokens", 0) > 20000:
        return f"max_tokens: {body['max_tokens']} > 20000, which is the maximum allowed"
    if model == "limit-unnamed" and body.get("max_tokens", 0) > 8192:
        return "max_tokens is too large for this model"
    if model == "bad-request":
        return "messages: something else is wrong"
    return None


def decide(messages: list) -> tuple[str, dict | None]:
    last = messages[-1]
    content = last.get("content")
    if last.get("role") == "tool" or (isinstance(content, list) and content and content[0].get("type") == "tool_result"):
        return "That is my proposal. Press Keep to write it.", None
    prompt = content if isinstance(content, str) else "".join(b.get("text", "") for b in content if b.get("type") == "text")
    message = prompt.split("</context>")[-1]
    if "slow" in message:
        return "slow", None
    wanted = re.search(r"read file (\S+)", message)
    if wanted:
        return "Reading that file.", {"name": "read_file", "input": {"rel": wanted.group(1)}}
    opened = re.search(r"Open file: (\S+)\n<open_file>\n(.*?)\n</open_file>", prompt, re.S)
    if opened and "\\badcommand" in opened.group(2):
        return "I found the bad command.", {"name": "propose_edit", "input": {
            "rel": opened.group(1), "old_text": "\\badcommand", "new_text": "fixed text",
            "summary": "Replace the undefined command"}}
    return "Nothing to fix here.", None


def serve(port: int = 0, expected_key: str | None = None) -> ThreadingHTTPServer:
    handler = type("Bound", (FakeProvider,), {"seen": [], "expected_key": expected_key})
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    server.daemon_threads = True
    server.handler = handler
    return server


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8799)
    args = parser.parse_args()
    print(f"fake provider on http://127.0.0.1:{args.port}", flush=True)
    serve(args.port).serve_forever()
