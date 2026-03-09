import os

BASE_URL = "http://localhost:8080"
REQUEST_TIMEOUT = 120


def get_proxy_api_key():
    """Read PROXY_API_KEY from .env file."""
    env_path = os.path.join(os.path.dirname(__file__), '..', '.env')
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith('PROXY_API_KEY=') and not line.startswith('#'):
                    return line.split('=', 1)[1]
    return ''


def auth_headers():
    """Return Authorization headers if PROXY_API_KEY is set."""
    key = get_proxy_api_key()
    if key:
        return {"Authorization": f"Bearer {key}"}
    return {}
