# CLI and Pi Tool Contract

## CLI

```text
agentx --project <name> pr update  --repository <name> --number <n> [--title <text>] [--body <md>]
agentx --project <name> pr append  --repository <name> --number <n>
agentx --project <name> pr sync    --repository <name> --number <n>
agentx --project <name> pr close   --repository <name> --number <n>
agentx --project <name> pr reopen  --repository <name> --number <n>
agentx --project <name> pr replace --repository <name> --number <n> --title <text> [--body <md>]
agentx --project <name> pr revert  --repository <name> --number <n> --title <text> [--body <md>]
```

All commands accept global `--json`, use generated request IDs, and wait for the durable terminal operation result.

## Local Pi tools

- `agentx_update_pull_request`: update title/body or append checked workspace changes.
- `agentx_sync_pull_request`: merge the latest base into an open AgentX PR.
- `agentx_close_pull_request`: close an eligible open PR.
- `agentx_reopen_pull_request`: reopen an eligible unmerged PR.
- `agentx_replace_pull_request`: create a clean replacement then close the original.
- `agentx_revert_pull_request`: create a revert PR for an eligible merged PR.

(feature 013 consolidates these into `agentx_manage_pull_request` with an `action` argument)

Descriptions explicitly state that rebasing/amending published branches and force pushing are unavailable. Local Pi receives no raw Git, shell, filesystem, or GitHub credential tool.
