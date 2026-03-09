## ADDED Requirements

### Requirement: OpenAI-Compatible API via gemini-cli
The system SHALL provide an API endpoint that is compatible with the OpenAI API format (Chat Completions) by internally executing the `gemini` CLI.

#### Scenario: Successful Chat Completion Proxying via CLI
- **WHEN** a client sends an OpenAI-formatted Chat Completion request to the proxy
- **THEN** the proxy SHALL execute `gemini -p "<prompt>" -o json` and return the response in OpenAI format.

### Requirement: Gemini Ultra Quota Leverage
The system SHALL use the user's existing Gemini Ultra quota from the authenticated CLI session.

#### Scenario: Request uses authenticated session
- **WHEN** a request is proxied through the CLI
- **THEN** it SHALL use the quota and model (Ultra) associated with the current CLI login.
