import pytest
import requests

BASE_URL = "http://localhost:8080"
REQUEST_TIMEOUT = 30

def test_list_models():
    """
    Scenario: Client lists available models
    - WHEN a client sends GET /v1/models
    - THEN the proxy SHALL return the list of available Gemini models in OpenAI format.
    """
    response = requests.get(f"{BASE_URL}/v1/models", timeout=REQUEST_TIMEOUT)

    assert response.status_code == 200
    data = response.json()
    assert data["object"] == "list"
    assert len(data["data"]) > 0

    model_ids = [m["id"] for m in data["data"]]
    assert "gemini-2.5-flash" in model_ids
    assert "gemini-2.5-pro" in model_ids

    for model in data["data"]:
        assert model["object"] == "model"
        assert model["owned_by"] == "google"
