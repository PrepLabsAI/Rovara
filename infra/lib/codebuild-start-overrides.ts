// Condition keys of codebuild:StartBuild (AWS Service Authorization Reference, list_awscodebuild.html, StartBuild row; read 2026-11-24) whose PRESENCE in a request means the caller
// is overriding something the project stores. The broker starts a gate project exactly as stored, so its StartBuild Allow requires every one of these ABSENT (Null "true").
// Conditions in one operator block are AND'ed: the Allow holds only when ALL are absent, so one override of any single key is enough to refuse the call.
//
// Which keys are listed, and which are not:
//  - one or more keys for every StartBuild override argument that has a key: buildspecOverride (source.buildspec), sourceTypeOverride (source), sourceLocationOverride (source.location),
//    sourceAuthOverride (source.auth.*), insecureSslOverride, buildStatusConfigOverride, imageOverride (environment.image), environmentTypeOverride, computeTypeOverride, certificateOverride,
//    imagePullCredentialsTypeOverride, privilegedModeOverride, environmentVariablesOverride (environment.environmentVariables), registryCredentialOverride, fleetOverride, secondarySourcesOverride,
//    secondaryArtifactsOverride, artifactsOverride, cacheOverride, logsConfigOverride, encryptionKeyOverride, serviceRoleOverride, autoRetryLimitOverride.
//  - for a STRUCTURE-valued override (artifacts, cache, logsConfig, secondaryArtifacts, registryCredential, environmentVariables, secondarySources) the key of the structure itself stands for the
//    argument; its member keys (artifacts.location, cache.type, logsConfig.s3Logs.*, ...) are not repeated: the policy-size headroom (the broker role's inline policies must stay under 8740
//    characters after ARN expansion, tests/contract/developer-signin-infrastructure.test.ts) does not hold all 53 listed keys. Members listed besides their structure key, because a swapped value there can
//    run attacker code: secondarySources.buildspec and .location, cache.location (an S3 cache restores attacker files that the stored buildspec then runs) and
//    environment.environmentVariables.name (BASH_ENV, NODE_OPTIONS). source.buildStatusConfig.* (status display only) is covered by `codebuild:source`.
//  - NOT listed, and why: the per-identifier forms (`codebuild:secondarySources/${sourceIdentifier}.*`, `codebuild:secondaryArtifacts/${artifactIdentifier}.*`,
//    `codebuild:environment.environmentVariables/${name}.value`): a condition key name cannot be a pattern, and the generic key of the same structure covers the argument.
//    StartBuild arguments with NO key in the reference (so IAM cannot see them): sourceVersion, secondarySourcesVersionOverride, timeoutInMinutesOverride, queuedTimeoutInMinutesOverride,
//    idempotencyToken, projectName, gitCloneDepthOverride, gitSubmodulesConfigOverride, reportBuildStatusOverride, debugSessionEnabled.
//    The broker sends projectName, sourceVersion, timeoutInMinutesOverride and idempotencyToken (packages/broker/src/codebuild.ts), none of which has a key.
export const CODEBUILD_START_OVERRIDE_KEYS: readonly string[] = [
  "codebuild:source", "codebuild:source.buildspec", "codebuild:source.location", "codebuild:source.auth.type", "codebuild:source.auth.resource", "codebuild:source.insecureSsl",
  "codebuild:cache.location", "codebuild:environment.environmentVariables.name",
  "codebuild:environment", "codebuild:environment.image", "codebuild:environment.type", "codebuild:environment.computeType", "codebuild:environment.certificate",
  "codebuild:environment.imagePullCredentialsType", "codebuild:environment.privilegedMode", "codebuild:environment.environmentVariables", "codebuild:environment.registryCredential",
  "codebuild:environment.fleet.fleetArn",
  "codebuild:secondarySources", "codebuild:secondarySources.buildspec", "codebuild:secondarySources.location",
  "codebuild:secondaryArtifacts", "codebuild:artifacts", "codebuild:cache", "codebuild:logsConfig",
  "codebuild:encryptionKey", "codebuild:serviceRole", "codebuild:autoRetryLimit",
];
