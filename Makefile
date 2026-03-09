.PHONY: up down logs test clean venv

VENV_DIR = .venv
PYTHON = $(VENV_DIR)/bin/python
PIP = $(VENV_DIR)/bin/pip

up: build
	docker compose up -d

build:
	docker compose build

down:
	docker compose down

logs:
	docker compose logs -f

venv:
	python3 -m venv $(VENV_DIR)
	$(PIP) install --upgrade pip
	$(PIP) install pytest requests openai

test: venv
	$(PYTHON) -m pytest tests/

clean:
	rm -rf $(VENV_DIR)
	rm -rf .pytest_cache
	find . -type d -name "__pycache__" -exec rm -rf {} +
