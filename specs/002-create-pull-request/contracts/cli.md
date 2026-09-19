# CLI and Orchestrator Contract

## Direct CLI

```text
agentx --project <project> pr create \
  --repository <registered-name> \
  --title <title> \
  [--body <markdown>]
```

The command resolves the authenticated ready workspace, generates a request ID, accepts one publish
operation, streams existing operation events, waits for terminal status, and prints the PR URL and
metadata. Global `--json` returns the normal stable envelope with the terminal operation.

## Local Pi tool

Tool name: `agentx_create_pull_request`.

Input: `repository`, `title`, optional `body`. Workspace/project identity comes from the bound
orchestration context and cannot be supplied by the model.

Output: the terminal operation including `PullRequestResult`.

The tool is added to the explicit orchestration allowlist. It grants no local file, shell, Git, or
GitHub credential access. The system prompt directs the local orchestrator to invoke it only after
an explicit user request to publish.
