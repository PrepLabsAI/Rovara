# Data Model: Project Worker Model Selection

## Project policy

`models.default` and each entry in `models.approved` contain `provider`, `modelId`, and optional `label`. Approved pairs and case-insensitive labels are unique; default must be approved.

## Mutable selection

```text
pk: PROJECT#<projectName>
sk: SELECTION
entityType: PROJECT_MODEL_SELECTION
model: { provider, modelId }
updatedAt: ISO-8601 timestamp
updatedBy: { teamId, userId }
```

## Resolution

Load the latest revision. A valid stored selection wins; otherwise use the default and attach a diagnostic when the stored selection is stale. With no project policy, omit the payload model for environment fallback. The worker adds deployment-controlled thinking and cache settings; session usage reports the actual model.
