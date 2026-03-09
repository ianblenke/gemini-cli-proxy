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
