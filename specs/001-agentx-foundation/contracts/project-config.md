# Project Configuration and CLI Contract

The commands below are implemented by the compiled `@agentx/cli` binary.

## Local project selection

Default directory: `~/.agentx/projects/`. Optional override: `--config-dir <path>`.
Select exactly `<name>.yaml`; validate name before constructing a path. Do not search arbitrary
working-directory files or execute configuration as code. The shared config cannot contain
`runtimeSessionId`, `workspaceId`, an owner identity, or secrets.

```yaml
schemaVersion: 2
name: payments
revision: 1
controlPlaneUrl: https://agentx.example.com
auth:
  issuer: https://identity.example.com
  clientId: agentx-cli
  audience: agentx
environment:
  image: registry.example.com/payments-dev@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
repositories:
  - name: api
    url: https://git.example.com/team/payments-api.git
    path: services/api
    defaultBranch: main
    credentialRef: payments-repo-access
setup:
  - cwd: services/api
    executable: npm
    args: [ci]
    timeoutSeconds: 600
readiness:
  - cwd: services/api
    executable: npm
    args: [test]
    timeoutSeconds: 600
orchestratorInstructions: Delegate code inspection, editing, and testing to the remote worker.
```

All URLs, identifiers and digests in the example are illustrative. The auth provider supports
browser login with PKCE or a documented device-flow integration; tokens belong in protected
client auth storage, not this file. Environment images are built and deployed by the administrator.

## Developer commands

- `agentx login --project payments --callback-port 8765`: authenticate to that project's
  configured control service using the exact loopback redirect registered with the OIDC client.
- `agentx --project payments`: validate config, resolve the owner's prepared workspace and open pi TUI.
- `agentx --project payments --prompt "..." --json`: submit one task and emit structured progress/result.
- `agentx status --project payments --json`: retrieve workspace and active/latest task status.
- `agentx conversation new --project payments`: create a conversation without changing code.
- `agentx cancel --project payments --operation <id>`: request cooperative cancellation.

No developer-facing command accepts runtime session IDs, runtime ARNs, or arbitrary remote paths.
Display the current project, private instance, conversation and preparation state in the TUI.

## Administrator commands

- `agentx admin project register --file ./payments.yaml --runtime-arn <arn> --deployment-mode demo-microvm`:
  register the definition and deployed runtime binding; requires the configured administrator claim.
- `agentx admin workspace prepare --project payments --owner <subject>`: initialize an owner's
  private instance and await readiness, without a coding task.
- `agentx admin workspace stop --project payments --workspace <id>`: stop idle compute, retain storage.

Deployment is an infrastructure workflow in `infra/`, separate from registration and preparation.
Developer startup fails with preparation guidance if an instance is absent or unready.

## Errors and output

Exit `0` for success, `2` for invalid arguments/config, `3` for authentication/authorization,
`4` for not-ready/busy/conflict, `5` for remote failure, `130` for local interruption.
JSON output is machine-readable on stdout; diagnostics go to stderr. Never output tokens.
