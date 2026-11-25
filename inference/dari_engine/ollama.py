"""Ollama's native text generation wire format, backed by Dari Metal."""

import json
import time
from datetime import UTC, datetime

from dari_engine.protocol import InvalidGeneration, prepare


def supported(obj, keys):
    if not isinstance(obj, dict):
        raise TypeError("Expected a JSON object")
    if unknown := obj.keys() - keys:
        raise ValueError(f"Unsupported fields: {', '.join(sorted(unknown))}")


def generate(handler, request):
    runtime = handler.server.runtime
    chat = handler.path == "/api/chat"
    start = time.monotonic_ns()
    try:
        if isinstance(request, dict) and not chat:
            # The official CLI serializes empty template and infill overrides.
            request = {
                k: v
                for k, v in request.items()
                if not (k in ("template", "suffix") and v == "")
            }
        supported(
            request,
            {"model", "stream", "options"}
            | ({"messages"} if chat else {"prompt", "system", "raw"}),
        )
        model = request["model"]
        name = handler.server.model_name
        if model not in (name, name + ":latest"):
            return handler.reply(404, {"error": f"model {model!r} not found"})
        options = request.get("options") or {}
        supported(options, {"num_ctx", "num_predict", "temperature"})
        window = options.get("num_ctx", runtime.context_window)
        if type(window) is not int or not 1 <= window <= runtime.model_max_length:
            raise ValueError(
                f"num_ctx must be between 1 and {runtime.model_max_length}"
            )
        stream = request.get("stream", True)
        if type(stream) is not bool:
            raise ValueError("stream must be a boolean")
        if chat:
            messages = request["messages"]
            for message in messages:
                supported(message, {"role", "content"})
        else:
            messages = [{"role": "user", "content": request["prompt"]}]
            if "system" in request:
                messages.insert(0, {"role": "system", "content": request["system"]})
        messages, _ = prepare({"messages": messages})
        if request.get("raw"):
            if "system" in request:
                raise ValueError("raw prompts cannot include a system message")
            ids = runtime.encode_raw(request["prompt"])
        else:
            ids = runtime.prompt(messages, [])
        remaining = window - len(ids)
        if not ids or remaining <= 0:
            raise ValueError(
                f"{len(ids)} prompt tokens leave no usable input/output budget in num_ctx={window}"
            )
        predict = options.get("num_predict", -1)
        if type(predict) is not int or (predict < 1 and predict != -1):
            raise ValueError("num_predict must be positive or -1")
        limit = remaining if predict == -1 else min(remaining, predict)
        temperature = float(options.get("temperature", 0))
        if not 0 <= temperature <= 2:
            raise ValueError("temperature must be between 0 and 2")
    except (KeyError, TypeError, ValueError) as error:
        return handler.reply(400, {"error": str(error)})

    def send_line(frame):
        handler.wfile.write(json.dumps(frame).encode() + b"\n")
        handler.wfile.flush()

    if stream:
        handler.send_response(200)
        handler.send_header("Content-Type", "application/x-ndjson")
        handler.end_headers()
    parts = []
    try:
        for delta, reason, count in runtime.events(ids, limit, temperature, set()):
            text = delta.get("content", "")
            if not stream:
                parts.append(text)
                if not reason:
                    continue
                text = "".join(parts)
            frame = {
                "model": model,
                "created_at": datetime.now(UTC).isoformat(),
                "done": bool(reason),
            }
            if chat:
                frame["message"] = {"role": "assistant", "content": text}
            else:
                frame["response"] = text
            if reason:
                frame.update(
                    done_reason=reason,
                    prompt_eval_count=len(ids),
                    eval_count=count,
                    total_duration=time.monotonic_ns() - start,
                )
            if stream:
                send_line(frame)
            else:
                handler.reply(200, frame)
    except InvalidGeneration as error:
        if stream:
            send_line({"error": str(error)})
        else:
            handler.reply(502, {"error": str(error)})
