# Worker Protocol Contract

## Clean publication

The existing `publish` invocation gains an optional mode:

- `create` (default): clean one-commit publication.
- `replace`: clean publication linked to an open original PR.
- `revert`: new branch reverting a merged PR.

Create/replace carry repository grant, deterministic new head branch, base branch, and expected target metadata. Revert additionally carries the verified merge commit.

## Maintain invocation

```json
{
  "kind": "maintain",
  "operationId": "uuid",
  "workspaceId": "uuid",
  "fence": 7,
  "projectRevision": 2,
  "callbackCapability": "opaque",
  "payload": {
    "action": "append | sync",
    "project": {},
    "repository": "personal-website",
    "pullRequestNumber": 12,
    "headBranch": "agentx/uuid",
    "baseBranch": "main",
    "expectedHeadCommit": "hex",
    "repositoryGrant": "opaque"
  }
}
```

The worker must fetch with the opaque credential, verify the remote head equals `expectedHeadCommit`, run checks before push, and use a normal non-force refspec. It reports the new head through the scoped callback.
