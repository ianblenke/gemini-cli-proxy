import json
import pytest
import requests

BASE_URL = "http://localhost:8080"
REQUEST_TIMEOUT = 120

WEATHER_TOOL = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get the current weather for a location",
        "parameters": {
            "type": "object",
            "properties": {
                "location": {"type": "string", "description": "City name"},
            },
            "required": ["location"],
        },
    },
}


def test_function_call_triggered():
    """
    Scenario: Model decides to call a tool
    - WHEN a request includes tools and the prompt triggers tool use
    - THEN the response SHALL contain tool_calls in OpenAI format.
    """
    payload = {
        "model": "gemini-2.5-flash",
        "messages": [
            {"role": "user", "content": "What is the weather in Paris right now?"},
        ],
        "tools": [WEATHER_TOOL],
    }
    response = requests.post(f"{BASE_URL}/v1/chat/completions", json=payload, timeout=REQUEST_TIMEOUT)

    assert response.status_code == 200
    data = response.json()
    choice = data["choices"][0]
    assert choice["finish_reason"] == "tool_calls"
    assert "tool_calls" in choice["message"]

    tool_call = choice["message"]["tool_calls"][0]
    assert tool_call["type"] == "function"
    assert tool_call["function"]["name"] == "get_weather"
    assert "id" in tool_call
    # arguments should be a JSON string
    args = json.loads(tool_call["function"]["arguments"])
    assert "location" in args


def test_function_call_roundtrip():
    """
    Scenario: Full tool use roundtrip
    - WHEN the model requests a tool call, the client provides the result,
      and the conversation continues
    - THEN the model SHALL use the tool result in its final response.
    """
    # Step 1: Initial request that triggers tool call
    payload = {
        "model": "gemini-2.5-flash",
        "messages": [
            {"role": "user", "content": "What is the weather in Paris right now?"},
        ],
        "tools": [WEATHER_TOOL],
    }
    resp1 = requests.post(f"{BASE_URL}/v1/chat/completions", json=payload, timeout=REQUEST_TIMEOUT)
    assert resp1.status_code == 200
    data1 = resp1.json()

    tool_call = data1["choices"][0]["message"]["tool_calls"][0]
    call_id = tool_call["id"]

    # Step 2: Send the tool result back
    payload2 = {
        "model": "gemini-2.5-flash",
        "messages": [
            {"role": "user", "content": "What is the weather in Paris right now?"},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [tool_call],
            },
            {
                "role": "tool",
                "tool_call_id": call_id,
                "name": "get_weather",
                "content": json.dumps({"temperature": 22, "condition": "sunny", "unit": "celsius"}),
            },
        ],
        "tools": [WEATHER_TOOL],
    }
    resp2 = requests.post(f"{BASE_URL}/v1/chat/completions", json=payload2, timeout=REQUEST_TIMEOUT)
    assert resp2.status_code == 200
    data2 = resp2.json()

    # The model should now respond with text using the tool result
    choice = data2["choices"][0]
    assert choice["finish_reason"] == "stop"
    assert "22" in choice["message"]["content"] or "sunny" in choice["message"]["content"].lower()


def test_function_call_streaming():
    """
    Scenario: Streaming with tool calls
    - WHEN a streaming request includes tools and triggers tool use
    - THEN tool_calls SHALL appear in streamed delta chunks.
    """
    payload = {
        "model": "gemini-2.5-flash",
        "messages": [
            {"role": "user", "content": "What is the weather in Paris right now?"},
        ],
        "tools": [WEATHER_TOOL],
        "stream": True,
    }
    response = requests.post(
        f"{BASE_URL}/v1/chat/completions", json=payload, timeout=REQUEST_TIMEOUT, stream=True
    )
    assert response.status_code == 200

    has_tool_call = False
    finish_reason = None
    for line in response.iter_lines(decode_unicode=True):
        if not line or not line.startswith("data: "):
            continue
        data_str = line[6:]
        if data_str == "[DONE]":
            break
        chunk = json.loads(data_str)
        delta = chunk["choices"][0]["delta"]
        fr = chunk["choices"][0]["finish_reason"]
        if fr:
            finish_reason = fr
        if "tool_calls" in delta:
            has_tool_call = True
            tc = delta["tool_calls"][0]
            assert tc["type"] == "function"
            assert "name" in tc["function"]

    assert has_tool_call, "Expected tool_calls in streaming response"
    assert finish_reason == "tool_calls"
