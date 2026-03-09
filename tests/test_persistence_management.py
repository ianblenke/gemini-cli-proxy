import subprocess
import pytest
import time
import requests

BASE_URL = "http://localhost:8080"

def test_makefile_up():
    """
    Scenario: User starts the service
    - WHEN the user runs `make up`
    - THEN the Docker Compose services SHALL be started in detached mode.
    """
    subprocess.run(["make", "down"], check=True)
    subprocess.run(["make", "up"], check=True)
    
    inspect = subprocess.run(["docker", "inspect", "-f", "{{.State.Running}}", "gemini-cli-proxy"], 
                             capture_output=True, text=True)
    assert inspect.stdout.strip() == "true"

def test_makefile_down():
    """
    Scenario: User stops the service
    - WHEN the user runs `make down`
    - THEN the Docker Compose services SHALL be stopped and containers removed.
    """
    subprocess.run(["make", "down"], check=True)
    inspect = subprocess.run(["docker", "inspect", "gemini-cli-proxy"], 
                             capture_output=True, text=True)
    assert inspect.returncode != 0

def test_restart_policy():
    """
    Scenario: Restart After Reboot
    - WHEN the system (container) is restarted
    - THEN the service SHALL recover.
    """
    subprocess.run(["make", "up"], check=True)
    time.sleep(5) 
    
    subprocess.run(["docker", "restart", "gemini-cli-proxy"], check=True)
    time.sleep(5)
    
    response = requests.get(f"{BASE_URL}/health/readiness")
    assert response.status_code == 200
