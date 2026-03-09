## ADDED Requirements

### Requirement: Gemini CLI Credential Usage
The system SHALL utilize existing `~/.gemini/` and `~/.config/gcloud/` credentials from the host machine for authentication.

#### Scenario: Proxying with Host CLI Credentials
- **WHEN** the proxy container starts
- **THEN** it SHALL have access to the mounted `.gemini/` and `.config/gcloud/` directories from the host.

### Requirement: Ultra Account Authentication
The system SHALL use the authenticated session in the mounted directories to authorize requests with Gemini Ultra.

#### Scenario: Successful Request with CLI Auth
- **WHEN** a Chat Completion request is received
- **THEN** the system SHALL execute the `gemini` command within the authenticated context.
