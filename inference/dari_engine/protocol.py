"""Validate chat requests before passing them to the selected model."""

import json


def prepare(request):
    tools = request.get("tools") or []
    if not isinstance(tools, list) or any(
        not isinstance(t, dict)
        or t.get("type") != "function"
        or not isinstance(t.get("function"), dict)
        or not isinstance(t["function"].get("name"), str)
        or not t["function"]["name"]
        for t in tools
    ):
        raise ValueError("Expected named function tools")
    choice = request.get("tool_choice", "auto")
    if choice == "none":
        tools = []
    elif choice != "auto":
        raise ValueError("Supported tool_choice values: auto, none")
    messages = request["messages"]
    if not isinstance(messages, list) or not messages:
        raise ValueError("Expected a nonempty message list")
    calls = {}
    for msg in messages:
        if msg["role"] == "developer":
            msg["role"] = "system"
        if msg["role"] not in ("user", "assistant", "system", "tool"):
            raise ValueError("Unsupported message role")
        content = msg.get("content")
        if content is None and msg["role"] == "assistant" and msg.get("tool_calls"):
            msg["content"] = ""
        elif not isinstance(content, str) and not (
            isinstance(content, list)
            and all(
                isinstance(p, dict)
                and p.get("type") == "text"
                and isinstance(p.get("text"), str)
                for p in content
            )
        ):
            raise ValueError("Only text message parts are supported")
        if msg["role"] == "assistant":
            for call in msg.get("tool_calls") or []:
                fn = call["function"]
                if isinstance(fn["arguments"], str):
                    fn["arguments"] = json.loads(fn["arguments"])
                if (
                    not isinstance(fn["arguments"], dict)
                    or not isinstance(fn["name"], str)
                    or call["id"] in calls
                ):
                    raise ValueError("Invalid assistant tool call in history")
                calls[call["id"]] = fn["name"]
        elif msg["role"] == "tool":
            # Resolve names from the original call, not from untrusted result text.
            msg["name"] = calls[msg["tool_call_id"]]
    return messages, tools


class InvalidGeneration(ValueError):
    pass
