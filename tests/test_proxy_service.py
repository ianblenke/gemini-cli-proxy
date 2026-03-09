import json
import pytest
import requests

BASE_URL = "http://localhost:8080"
REQUEST_TIMEOUT = 120  # seconds

def test_openai_compatible_chat_completion():
    """
    Scenario: Successful Chat Completion Proxying
    - WHEN a client sends an OpenAI-formatted Chat Completion request to the proxy
    - THEN the proxy SHALL return the response in OpenAI format.
    """
    payload = {
        "model": "gemini-2.5-flash",
        "messages": [{"role": "user", "content": "Say hello!"}]
    }
    response = requests.post(f"{BASE_URL}/v1/chat/completions", json=payload, timeout=REQUEST_TIMEOUT)

    assert response.status_code == 200
    data = response.json()
    assert "choices" in data
    assert len(data["choices"]) > 0
    assert "message" in data["choices"][0]
    assert "content" in data["choices"][0]["message"]

def test_gemini_ultra_quota_leverage():
    """
    Scenario: Request uses authenticated session
    - WHEN a request is proxied
    - THEN it SHALL use the quota associated with the current CLI login.
    """
    payload = {
        "model": "gemini-2.5-flash",
        "messages": [{"role": "user", "content": "What is the capital of France?"}]
    }
    response = requests.post(f"{BASE_URL}/v1/chat/completions", json=payload, timeout=REQUEST_TIMEOUT)
    assert response.status_code == 200
    assert "choices" in response.json()
    assert len(response.json()["choices"][0]["message"]["content"]) > 0

def test_streaming_chat_completion():
    """
    Scenario: Streaming Chat Completion
    - WHEN a client sends a request with stream=true
    - THEN the proxy SHALL return SSE chunks in OpenAI streaming format.
    """
    payload = {
        "model": "gemini-2.5-flash",
        "messages": [{"role": "user", "content": "Say hello!"}],
        "stream": True,
    }
    response = requests.post(
        f"{BASE_URL}/v1/chat/completions", json=payload, timeout=REQUEST_TIMEOUT, stream=True
    )

    assert response.status_code == 200
    assert "text/event-stream" in response.headers.get("Content-Type", "")

    chunks = []
    content = ""
    for line in response.iter_lines(decode_unicode=True):
        if not line or not line.startswith("data: "):
            continue
        data_str = line[6:]
        if data_str == "[DONE]":
            break
        chunk = json.loads(data_str)
        chunks.append(chunk)
        assert chunk["object"] == "chat.completion.chunk"
        delta = chunk["choices"][0]["delta"]
        if "content" in delta:
            content += delta["content"]

    assert len(chunks) > 0
    assert len(content) > 0

def test_thinking_chat_completion():
    """
    Scenario: Thinking/Reasoning Chat Completion
    - WHEN a client sends a request with thinking.budget_tokens > 0
    - THEN the proxy SHALL return reasoning_content alongside content.
    """
    payload = {
        "model": "gemini-2.5-flash",
        "messages": [{"role": "user", "content": "What is 2+2?"}],
        "thinking": {"budget_tokens": 1024},
    }
    response = requests.post(f"{BASE_URL}/v1/chat/completions", json=payload, timeout=REQUEST_TIMEOUT)

    assert response.status_code == 200
    data = response.json()
    message = data["choices"][0]["message"]
    assert len(message["content"]) > 0
    assert "reasoning_content" in message
    assert len(message["reasoning_content"]) > 0

def test_streaming_with_thinking():
    """
    Scenario: Streaming with Thinking
    - WHEN a client sends a streaming request with thinking enabled
    - THEN the proxy SHALL stream reasoning_content deltas before content deltas.
    """
    payload = {
        "model": "gemini-2.5-flash",
        "messages": [{"role": "user", "content": "What is 2+2?"}],
        "stream": True,
        "thinking": {"budget_tokens": 1024},
    }
    response = requests.post(
        f"{BASE_URL}/v1/chat/completions", json=payload, timeout=REQUEST_TIMEOUT, stream=True
    )

    assert response.status_code == 200

    has_reasoning = False
    has_content = False
    for line in response.iter_lines(decode_unicode=True):
        if not line or not line.startswith("data: "):
            continue
        data_str = line[6:]
        if data_str == "[DONE]":
            break
        chunk = json.loads(data_str)
        delta = chunk["choices"][0]["delta"]
        if "reasoning_content" in delta:
            has_reasoning = True
        if "content" in delta:
            has_content = True

    assert has_reasoning, "Expected reasoning_content chunks in streaming response"
    assert has_content, "Expected content chunks in streaming response"
