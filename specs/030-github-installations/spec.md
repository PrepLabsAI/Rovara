# Feature Specification: GitHub App Installation per Repository Owner

**Feature Branch**: `feat/123-github-installations`  
**Created**: 2026-09-27  
**Status**: Approved  
**Input**: Issue #123

## User Scenario

### An administrator registers a project in any account the GitHub App is installed on (Priority: P1)

The AgentX GitHub App is installed on `ps06756` and on `PrepLabsAI`. An administrator registers a project whose
repository is in either account, and its workspaces clone, push and open pull requests without any per-account
configuration. A repository the App cannot see is refused at registration with a message saying where to install it.

## Requirements

- **FR-001**: The broker MUST find a repository's installation from its owner
  (`GET /repos/{owner}/{repo}/installation`, authenticated as the App), cache it per owner for the process's
  lifetime, and not cache a failed lookup.
- **FR-002**: When a token request for a cached installation returns 404 (the App was reinstalled), the broker MUST
  look the installation up once more and retry.
- **FR-003**: Clone and push tokens, GitHub MCP credentials and pull request calls MUST use the owner as GitHub
  spells it (the installation's account login).
- **FR-004**: Registration MUST refuse, with `CONFIG_INVALID`, a repository of the App's credential that the App
  cannot see.
- **FR-005**: There MUST be no account allowlist: only administrators register repositories, and an installation
  token reaches only its own installation's repositories.
- **FR-006**: The control plane MUST drop the `GitHubAppAccount` and `GitHubAppInstallationId` parameters.
  `agentx deploy` stops passing them and still accepts answer files that contain them.

## Success Criteria

- **SC-001**: In production, `personal-website` (ps06756) still prepares and pushes after the release.
- **SC-002**: A project on `PrepLabsAI/Sample-Project-A` registers, and a repository the App cannot see is refused.
- **SC-003**: Typecheck, lint and the full test suite pass.
