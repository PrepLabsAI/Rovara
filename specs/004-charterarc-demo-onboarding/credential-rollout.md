# Additive GitHub App rollout

Scope: credential routing only. The owner approved the implementation plan on
2026-09-20. Keep this work on `codex/charterarc-demo-setup`; no automatic mainline
merge or AWS deployment. Separate Team Tasks runtime/project admission, candidate
freeze/publication (#2), and conversation continuity (#1) remain separate work.

## Configuration

All existing `GitHubApp*` CloudFormation parameters remain required and unchanged.
No additional registry is emitted by default. The old app continues to serve
repositories not explicitly assigned to a new binding. An assigned repository with
a wrong credential reference is rejected; an installation/key/network failure never
falls back to a different app.

CloudFormation rules compare every additional reference against the actual
`GitHubAppCredentialRef` deployment parameter, including retained nondefault
values. A collision must reject deployment before any broker update. Runtime
validation remains as a second check for manually configured environments.

CDK context `agentxAdditionalGitHubApps` accepts an array or a JSON array string.
Each entry requires `credentialRef`, `account`, `appId`, `installationId`,
`privateKeySecretArn`, and a nonempty `repositories` allowlist. Secret ARNs are
metadata; never put PEM/token values in context, project YAML or command arguments.
The broker receives this validated array in `GITHUB_APP_ADDITIONAL_BINDINGS`.

For the CharterArc demo, use reference `github-charterarc-demo`, account
`PrepLabsAI`, app `5006456`, installation `163149623`, and only repository
`https://github.com/PrepLabsAI/charterarc-integration-demo.git`. Obtain the exact
secret ARN from the successful new-secret creation receipt. Do not invent its suffix.

With additional bindings enabled, CDK requires concrete deployment account and
region; secret ARNs must match both. `CDK_DEFAULT_ACCOUNT` comes from the chosen
AWS operator profile; region comes from `agentxRegion` or `CDK_DEFAULT_REGION`.
The registry has a 2-KiB ceiling. Check the complete resolved Lambda environment
against AWS's 4-KiB limit before deployment; legacy parameter values cannot be
fully counted during synthesis. Only the AWS-managed Secrets Manager key is in
this rollout. A customer-managed KMS key requires explicit narrow decrypt grants,
which this package does not add.

Repository host/owner/name matching is case-insensitive, with exactly one literal
lowercase `.git` transport suffix removed, matching the existing GitHub API adapter.
Use canonical HTTPS URLs without credentials, ports, query, fragment, encoding or
dot segments. A repository name itself ending in `.git` requires a doubled suffix
in its canonical clone URL. Unrelated public repository no-credential behavior is
preserved. This is not an enterprise multi-tenant credential registry.

## Operator sequence

1. Establish a short-lived scoped AWS session; independently check its account and
   role. Keep the audit profile and existing app secret unchanged.
2. Check metadata for the proposed new secret name. If it already exists, stop and
   reconcile; do not overwrite it. If absent, create it by reading the local PEM
   file directly. Output only secret name, ARN and version receipt, never contents.
3. Inspect `git status --short`, record the exact clean source commit/tree, run
   `npm ci --ignore-scripts`, `npm run build`, `npm run lint`, and `npm test` with
   Node 22.23.2. Archive results outside the source tree.
4. Supply the nonsecret binding context and synthesize `AgentXControlPlane` with
   the correct AWS profile/account/region. Preserve previous values for every
   legacy parameter, especially callback signing key and existing GitHub App.
5. Review the actual CloudFormation change set before execution. Expected: broker
   optional environment and exact new secret permission; packaged handler assets
   may change because they share contract imports. No state table, bucket, queue,
   endpoint, runtime replacement, new wildcard secret access or worker key access.
6. Apply only the reviewed control-plane changes through an authorized deployment
   role. The initial setup role deliberately does not provide this authority.
7. Capture the deployed Lambda code identity and a build receipt linking it to the
   reviewed source commit. Runtime version numbers alone do not identify source.
8. Smoke-test an existing authorized project and the new registered demo project.
   Verify each uses the intended installation, private clone succeeds, wrong-ref
   requests fail, and the worker never receives the App PEM. Do not push or create
   a PR as an implicit consequence of a clone test. Name and approve the exact
   demo candidate branch/publication action first.

Project registration and a compatible Team Tasks runtime are still prerequisites
for the second smoke test. Local fake-network tests are not this live proof.

## Rollback

Stop admission of new demo work; reconcile in-flight operations before removing its
binding. Restore the preceding reviewed broker code/configuration while preserving
legacy parameters. Do not route a failed new-app operation through the old app.
Retain receipts, candidate refs and evidence. Do not delete or replace either key,
runtime, project or state table as routine rollback. Targeted destructive cleanup
requires its own explicit operator decision.

Revoking the human setup role stops setup access; it does not revoke the broker's
runtime secret permission or uninstall the GitHub App. Those are separate actions.
