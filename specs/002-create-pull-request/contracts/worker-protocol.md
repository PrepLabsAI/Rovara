# Worker Protocol Additions

Protocol version remains `1`; invocation kind adds `publish`.

```json
{
  "protocolVersion": 1,
  "kind": "publish",
  "operationId": "00000000-0000-4000-8000-000000000002",
  "workspaceId": "00000000-0000-4000-8000-000000000003",
  "fence": 7,
  "projectRevision": 1,
  "callbackCapability": "signed-capability",
  "payload": {
    "project": {},
    "repository": "personal-website",
    "title": "Improve homepage navigation",
    "body": "Summary and validation notes",
    "headBranch": "agentx/00000000-0000-4000-8000-000000000002",
    "repositoryGrant": "signed-repository-grant"
  }
}
```

Worker order is fixed:

1. validate the complete preparation manifest and selected configured checkout;
2. reject unresolved conflicts or no changes;
3. run all registered readiness commands and record bounded results;
4. create or reconcile the deterministic local branch and AgentX commit;
5. exchange the exact push grant and push without force through ephemeral askpass;
6. request broker-side PR reconciliation through the callback capability;
7. post the terminal result through the existing callback.

No Pi session is started for this operation. Duplicate operation IDs use the worker journal.
Retries reconcile the deterministic branch/commit before repeating an external action. An ambiguous
side effect is reported as interrupted unless external state confirms it.
