## ADDED Requirements

### Requirement: Docker Compose Orchestration
The system SHALL be manageable via Docker Compose.

#### Scenario: Running the Service
- **WHEN** the user runs `docker compose up -d`
- **THEN** the proxy service SHALL start in the background.

### Requirement: Automatic System Restart
The service SHALL survive system restarts.

#### Scenario: Restart After Reboot
- **WHEN** the system is rebooted
- **THEN** the Docker daemon SHALL automatically restart the proxy container if it was previously running.
