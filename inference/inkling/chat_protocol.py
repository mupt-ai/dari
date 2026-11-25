"""Translate OpenAI chat history and Inkling's token-framed assistant messages.

Tool execution belongs to the client. A native call is opaque until its closing
marker: never stream an executable prefix of an incomplete or malformed call.
"""

import json
import uuid

from dari_engine.protocol import InvalidGeneration


def assistant_events(tokenizer, tokens, names, limit):
    """Yield (OpenAI delta, finish reason, sampled count) for either transport."""
    markers = {
        tokenizer.convert_tokens_to_ids(f"<|{name}|>"): name
        for name in (
            "message_model",
            "content_text",
            "content_thinking",
            "content_invoke_tool_json",
            "end_message",
        )
    }
    decoder = tokenizer.detokenizer
    decoder.reset()
    channel = "header" if names else "content_text"
    buffer = []
    name = None
    completed = []
    reason = "length"
    for count, token in enumerate(tokens, 1):
        marker = markers.get(token)
        eos = token in tokenizer.eos_token_ids
        if marker or eos:
            if channel == "content_text":
                decoder.finalize()
                if tail := decoder.last_segment:
                    yield {"content": tail}, None, count
            if channel == "content_invoke_tool_json":
                if marker != "end_message":
                    raise InvalidGeneration("Unterminated tool call")
                try:
                    payload = json.loads(tokenizer.decode(buffer))
                    if (
                        not isinstance(payload, dict)
                        or name not in names
                        or payload.get("name") != name
                        or not isinstance(payload.get("args"), dict)
                    ):
                        raise ValueError("Invalid tool name or arguments")
                except ValueError as error:
                    raise InvalidGeneration(
                        "Malformed or undeclared tool call"
                    ) from error
                completed.append(
                    {
                        "index": len(completed),
                        "id": "call_" + uuid.uuid4().hex,
                        "type": "function",
                        "function": {
                            "name": name,
                            "arguments": json.dumps(payload["args"]),
                        },
                    }
                )
            if eos or (not names and marker == "end_message"):
                reason = "tool_calls" if completed else "stop"
                break
            if marker == "content_invoke_tool_json":
                name = tokenizer.decode(buffer)
            if marker == "content_text":
                decoder.reset()
            channel = "header" if marker in ("message_model", "end_message") else marker
            buffer = []
        elif channel == "content_text":
            decoder.add_token(token)
            if text := decoder.last_segment:
                yield {"content": text}, None, count
        elif channel in ("header", "content_invoke_tool_json"):
            buffer.append(token)
        if count == limit:
            if channel == "content_text":
                decoder.finalize()
                if tail := decoder.last_segment:
                    yield {"content": tail}, None, count
            break
    # A closed native message is complete even if the outer turn EOS does
    # not fit in the token budget. Never publish an unfinished sibling.
    if completed:
        reason = "tool_calls"
        yield {"tool_calls": completed}, None, count
    yield {}, reason, count
