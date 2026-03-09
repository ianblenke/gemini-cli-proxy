import subprocess
import time
import os
import pytest
import requests
from conftest import BASE_URL, REQUEST_TIMEOUT, get_proxy_api_key

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
    env = os.environ.copy()
    env_path = os.path.join(os.path.dirname(__file__), '..', '.env')
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, val = line.split("=", 1)
                env[key] = val
    return env


def _restore_original():
    """Restore the proxy with original .env settings."""
    key = get_proxy_api_key()
    _restart_with_env({"PROXY_API_KEY": key})


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
        _restore_original()


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
        _restore_original()


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
        _restore_original()


def test_no_auth_when_key_not_set():
    """
    Scenario: No API key configured
    - WHEN PROXY_API_KEY is not set
    - THEN requests without Authorization header SHALL succeed.
    """
    try:
        _restart_with_env({"PROXY_API_KEY": ""})
        response = requests.get(f"{BASE_URL}/v1/models", timeout=REQUEST_TIMEOUT)
        assert response.status_code == 200
    finally:
        _restore_original()
