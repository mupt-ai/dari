"""Loopback HTTP transports for the selected Dari model."""

import json
import time
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer

from dari_engine.protocol import InvalidGeneration, prepare


class ChatHandler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def do_HEAD(self):
        self.send_response(200 if self.path == "/" else 404)
        self.end_headers()

    def do_GET(self):
        if self.path != "/v1/models":
            return self.send_error(404)
        self.reply(
            200,
            {
                "object": "list",
                "data": [
                    {
                        "id": self.server.model_name,
                        "object": "model",
                        "owned_by": self.server.model.repository.split("/", 1)[0],
                        "context_window": self.server.runtime.context_window,
                    }
                ],
            },
        )

    def do_POST(self):
        native = self.path in ("/api/chat", "/api/generate", "/api/show")
        if not native and self.path != "/v1/chat/completions":
            return self.send_error(404)
        if not native and self.headers.get_content_type() != "application/json":
            return self.send_error(415, "Expected application/json")
        if self.headers.get("Origin") or self.headers.get("Host", "").split(":")[
            0
        ] not in ("localhost", "127.0.0.1"):
            return self.send_error(403, "Local chat clients only")
        name = self.server.model_name
        backend = self.server.model.backend
        runtime = self.server.runtime
        try:
            size = int(self.headers.get("Content-Length", 0))
            if not 0 < size <= 4_000_000:
                raise ValueError("Invalid request size")
            request = json.loads(self.rfile.read(size))
            if self.path == "/api/show":
                model = request.get("model") or request.get("name")
                if model not in (name, name + ":latest"):
                    return self.reply(404, {"error": f"model {model!r} not found"})
                return self.reply(
                    200,
                    {
                        "capabilities": ["completion"],
                        "details": {
                            "family": backend.FAMILY,
                            "format": backend.WEIGHT_FORMAT,
                        },
                        "model_info": {
                            "general.architecture": backend.FAMILY,
                            f"{backend.FAMILY}.context_length": runtime.model_max_length,
                        },
                    },
                )
            if native:
                from dari_engine.ollama import generate

                return generate(self, request)
            if request["model"] != name:
                raise ValueError(f"Expected model {name}")
            messages, tools = prepare(request)
            stream_options = request.get("stream_options") or {}
            if not isinstance(stream_options, dict):
                raise TypeError("Expected stream_options object")
            limit = int(
                request.get("max_completion_tokens", request.get("max_tokens", 512))
            )
            temperature = float(request.get("temperature", 0))
            ids = runtime.prompt(messages, tools)
            if limit < 1 or not 0 <= temperature <= 2:
                raise ValueError(
                    "Expected positive output token budget and temperature between 0 and 2"
                )
            if len(ids) + limit > runtime.context_window:
                raise ValueError(
                    f"{len(ids)} prompt + {limit} requested output tokens exceed "
                    f"the {runtime.context_window:,}-token context window"
                )
        except (TypeError, ValueError, KeyError) as error:
            return self.reply(
                400,
                {
                    "error": str(error)
                    if native
                    else {"message": str(error), "type": "invalid_request_error"}
                },
            )

        meta = {
            "id": "chatcmpl-" + uuid.uuid4().hex,
            "model": name,
            "created": int(time.time()),
        }
        output = runtime.events(
            ids,
            limit,
            temperature,
            {t["function"]["name"] for t in tools},
        )

        def usage(count):
            return {
                "prompt_tokens": len(ids),
                "prompt_tokens_details": {"cached_tokens": runtime.cached_tokens},
                "completion_tokens": count,
                "total_tokens": len(ids) + count,
            }

        if not request.get("stream"):
            parts = []
            calls = []
            try:
                for delta, reason, count in output:
                    if "content" in delta:
                        parts.append(delta["content"])
                    for call in delta.get("tool_calls", []):
                        calls.append({k: v for k, v in call.items() if k != "index"})
            except InvalidGeneration as error:
                return self.reply(
                    502,
                    {"error": {"message": str(error), "type": "invalid_model_output"}},
                )
            message = {
                "role": "assistant",
                "content": "".join(parts) if parts or not calls else None,
            }
            if calls:
                message["tool_calls"] = calls
            self.reply(
                200,
                dict(
                    **meta,
                    object="chat.completion",
                    choices=[{"index": 0, "message": message, "finish_reason": reason}],
                    usage=usage(count),
                ),
            )
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()

        def emit(delta, finish=None):
            chunk = dict(
                **meta,
                object="chat.completion.chunk",
                choices=[{"index": 0, "delta": delta, "finish_reason": finish}],
            )
            self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())

        try:
            emit({"role": "assistant"})
            for delta, reason, count in output:
                if delta:
                    emit(delta)
                if reason:
                    emit({}, reason)
            if stream_options.get("include_usage"):
                chunk = dict(
                    **meta,
                    object="chat.completion.chunk",
                    choices=[],
                    usage=usage(count),
                )
                self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
            self.wfile.write(b"data: [DONE]\n\n")
        except InvalidGeneration as error:
            body = json.dumps(
                {"error": {"message": str(error), "type": "invalid_model_output"}}
            )
            self.wfile.write(f"data: {body}\n\ndata: [DONE]\n\n".encode())
        except (BrokenPipeError, ConnectionResetError):
            pass  # The last completed prefix remains reusable.


def serve(name, model, snapshot, port, context_window):
    with HTTPServer(("127.0.0.1", port), ChatHandler) as server:
        server.model_name = name
        server.model = model
        server.runtime = model.backend.load(snapshot, context_window)
        print(
            f"{name} ready on port {server.server_port}; context: {context_window:,} tokens; weights: {snapshot}",
            flush=True,
        )
        server.serve_forever()
