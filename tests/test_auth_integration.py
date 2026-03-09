import subprocess
import pytest
import requests
from conftest import BASE_URL, REQUEST_TIMEOUT, auth_headers

def test_auth_integration_gemini_mounting():
    """
    Scenario: Proxying with Host CLI Credentials
    - WHEN the proxy container starts
    - THEN it SHALL have access to the mounted .gemini/ directory from the host.
    """
    result = subprocess.run([
        "docker", "exec", "gemini-cli-proxy", "ls", "/home/node/.gemini"
    ], capture_output=True, text=True)
    assert result.returncode == 0
    assert "oauth_creds.json" in result.stdout

def test_gemini_cli_auth_success():
    """
    Scenario: Successful Request with CLI Auth
    - WHEN a Chat Completion request is received
    - THEN the system SHALL execute within the authenticated context.
    """
    payload = {
        "model": "gemini-2.5-flash",
        "messages": [{"role": "user", "content": "Ping"}]
    }
    response = requests.post(f"{BASE_URL}/v1/chat/completions", json=payload, headers=auth_headers(), timeout=REQUEST_TIMEOUT)

    assert response.status_code == 200
    assert "choices" in response.json()
