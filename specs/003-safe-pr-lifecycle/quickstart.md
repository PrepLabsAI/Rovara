# Quickstart: Safe Pull Request Lifecycle

## Local gates

```sh
npm run typecheck
npm run lint
npm test
npm run infra:synth:demo
```

Expected evidence includes disposable Git histories proving clean-base one-commit publication, fast-forward append, merge-based sync, replacement create-before-close, merged revert, ownership rejection, idempotency, and rejection of force-like push arguments.

Local validation on 2026-09-19:

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: 28 files and 101 tests passed.
- `npm run infra:synth:demo`: passed for `AgentXDemoRuntime`.
- AWS build/deployment and non-destructive live acceptance remain pending (T029).

## Clean publication regression

1. Prepare a repository workspace from `main`.
2. Create and locally retain several earlier `agentx/*` publication commits.
3. Advance remote `main` independently and make a workspace edit.
4. Create a new PR.
5. Verify the PR branch parent is the fetched remote `main`, contains one AgentX commit, preserves compatible upstream changes, and contains none of the earlier publication commits.

## Existing PR maintenance

1. Create a disposable AgentX PR.
2. Ask remote Pi to make a follow-up change.
3. Run `agentx --project <project> pr append --repository <repo> --number <n>` and verify a fast-forward update.
4. Advance `main`, run `pr sync`, and verify a merge-based update to the same PR.
5. Run `pr update`, `pr close`, and `pr reopen`; verify the number remains unchanged.

Only unpublished commits may be amended or rebased. After a commit is published, use `pr append`
for an ordinary fast-forward update or `pr replace` for clean history. AgentX has no force-push
escape hatch.

## Replacement and revert

1. Replace an open disposable PR and verify a new one-commit branch/PR exists before the original closes.
2. Merge a disposable PR manually.
3. Run `pr revert` and verify a new reviewable inverse-change PR is created without changing `main` directly.

## Live safety checks

- Inspect worker and broker logs for secret redaction.
- Confirm the GitHub App token requests are single-repository and minimally permissioned.
- Confirm no generated command contains `--force`, `--force-with-lease`, or a `+` refspec.
- Do not merge acceptance PRs automatically; close them after verification.
