# Worker Protocol Contract

The registered project definition embedded in `publish` and `maintain` invocations contains the gate definitions. The existing callback capability adds only the `codebuild` action for operations permitted to publish.

Publication results add:

```json
{
  "codeBuildChecks": [
    {
      "gate": "quality",
      "projectName": "agentx-website-quality",
      "buildId": "agentx-website-quality:uuid",
      "status": "SUCCEEDED",
      "requestedSourceVersion": "commit",
      "resolvedSourceVersion": "commit",
      "currentPhase": "COMPLETED",
      "startedAt": "2026-09-19T12:00:00.000Z",
      "completedAt": "2026-09-19T12:04:00.000Z",
      "logsUrl": "https://console.aws.amazon.com/..."
    }
  ]
}
```

The worker treats every non-`SUCCEEDED` terminal status, polling deadline, invalid response, or resolved-source mismatch as a failed publication.
