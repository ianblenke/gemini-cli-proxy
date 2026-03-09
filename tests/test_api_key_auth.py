import subprocess
import time
import pytest
import requests

BASE_URL = "http://localhost:8080"
REQUEST_TIMEOUT = 30
TEST_API_KEY = "test-secret-key-12345"


def _restart_with_env(env_vars):
    """Restart the proxy container with additional environment variables."""
    subprocess.run(["docker", "compose", "down"], check=True, capture_output=True)
    subprocess.run(
        ["docker", "compose", "up", "-d"],
        check=True,
        capture_output=True,
        env={**_get_base_env(), **env_vars},
    )
    # Wait for the container to be ready
    for _ in range(20):
        try:
            resp = requests.get(f"{BASE_URL}/health/readiness", timeout=2)
            if resp.status_code == 200:
                return
        except requests.ConnectionError:
            pass
        time.sleep(0.5)
    raise RuntimeError("Container did not become ready")


def _get_base_env():
    """Get the base environment from .env file and system."""
    import os
    env = os.environ.copy()
    # Read .env file
    with open(".env") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, val = line.split("=", 1)
                env[key] = val
    return env


def test_no_auth_when_key_not_set():
    """
    Scenario: No API key configured
    - WHEN PROXY_API_KEY is not set
    - THEN requests without Authorization header SHALL succeed.
    """
    # Default deployment has no PROXY_API_KEY set
    response = requests.get(f"{BASE_URL}/v1/models", timeout=REQUEST_TIMEOUT)
    assert response.status_code == 200


def test_auth_rejects_missing_header():
    """
    Scenario: API key configured but request has no auth header
    - WHEN PROXY_API_KEY is set and a request has no Authorization header
    - THEN the proxy SHALL return 401.
    """
    try:
        _restart_with_env({"PROXY_API_KEY": TEST_API_KEY})
        response = requests.get(f"{BASE_URL}/v1/models", timeout=REQUEST_TIMEOUT)
        assert response.status_code == 401
        assert "auth_error" in response.json()["error"]["type"]
    finally:
        # Restore original state (no API key)
        _restart_with_env({"PROXY_API_KEY": ""})


def test_auth_rejects_wrong_key():
    """
    Scenario: API key configured but request has wrong key
    - WHEN PROXY_API_KEY is set and request sends a wrong Bearer token
    - THEN the proxy SHALL return 401.
    """
    try:
        _restart_with_env({"PROXY_API_KEY": TEST_API_KEY})
        response = requests.get(
            f"{BASE_URL}/v1/models",
            headers={"Authorization": "Bearer wrong-key"},
            timeout=REQUEST_TIMEOUT,
        )
        assert response.status_code == 401
    finally:
        _restart_with_env({"PROXY_API_KEY": ""})


def test_auth_accepts_correct_key():
    """
    Scenario: API key configured and request sends correct key
    - WHEN PROXY_API_KEY is set and request sends matching Bearer token
    - THEN the proxy SHALL allow the request.
    """
    try:
        _restart_with_env({"PROXY_API_KEY": TEST_API_KEY})
        response = requests.get(
            f"{BASE_URL}/v1/models",
            headers={"Authorization": f"Bearer {TEST_API_KEY}"},
            timeout=REQUEST_TIMEOUT,
        )
        assert response.status_code == 200
        assert response.json()["object"] == "list"
    finally:
        _restart_with_env({"PROXY_API_KEY": ""})
