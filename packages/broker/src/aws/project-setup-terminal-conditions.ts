import type { ProjectSetupExecution } from "@agentx/contracts";
import { projectSetupSessionKey, type ProjectSetupSession } from "@agentx/contracts";
import { projectSetupRuntimeKey, type ProjectSetupRuntimeRecord } from "./project-setup-runtime-catalog.js";

type TerminalExecutionAuthority = Pick<ProjectSetupExecution,
  "setupExecutionId" | "ownerKey" | "projectName" | "projectRevision" | "approvalRevision" | "proposalRef" | "proposalSha256" | "candidateDigest" | "policyDigest"
  | "runtimeCatalogId" | "runtimeCatalogRevision" | "bindingDigest" | "runtimeGeneration" | "transportCorrelationId">;
type TerminalRuntimeIdentity = ProjectSetupRuntimeRecord;
type TerminalSessionIdentity = Pick<ProjectSetupSession, "setupExecutionId" | "subjectId" | "generation" | "transportCorrelationId" | "bindingDigest" | "approvalRevision">;

/** DynamoDB conditions that fence terminal writes against the authority checked before evidence verification. */
export function projectSetupTerminalAuthorityChecks(
  tableName: string,
  execution: TerminalExecutionAuthority,
  runtime: TerminalRuntimeIdentity,
  session: TerminalSessionIdentity,
) {
  // The exact binding digest is order-sensitive. `contains` plus a matching list size would
  // accept the same subnet set in a different order, so fence every indexed entry.
  const subnetConditions = runtime.binding.subnets.flatMap((_, index) => [
    `binding.#subnets[${index}].availabilityZone = :subnetAz${index}`,
    `binding.#subnets[${index}].subnetId = :subnetId${index}`,
  ]);
  const subnetValues = Object.fromEntries(runtime.binding.subnets.flatMap((subnet, index) => [
    [`:subnetAz${index}`, subnet.availabilityZone], [`:subnetId${index}`, subnet.subnetId],
  ]));
  const projectSubnetConditions = runtime.binding.subnets.flatMap((_, index) => [
    `runtimeBinding.#subnets[${index}].availabilityZone = :projectSubnetAz${index}`,
    `runtimeBinding.#subnets[${index}].subnetId = :projectSubnetId${index}`,
  ]);
  const projectSubnetValues = Object.fromEntries(runtime.binding.subnets.flatMap((subnet, index) => [
    [`:projectSubnetAz${index}`, subnet.availabilityZone], [`:projectSubnetId${index}`, subnet.subnetId],
  ]));
  return [
    { ConditionCheck: {
      TableName: tableName,
      Key: { pk: `MEMBER#${execution.ownerKey}`, sk: `PROJECT#${execution.projectName}` },
      ConditionExpression: "entityType = :membership AND ownerKey = :ownerKey AND projectName = :projectName AND #role = :administrator",
      ExpressionAttributeNames: { "#role": "role" },
      ExpressionAttributeValues: { ":membership": "MEMBERSHIP", ":ownerKey": execution.ownerKey, ":projectName": execution.projectName, ":administrator": "administrator" },
    } },
    { ConditionCheck: {
      TableName: tableName,
      Key: { pk: `PROJECT#${execution.projectName}`, sk: `REV#${String(execution.projectRevision).padStart(12, "0")}` },
      ConditionExpression: ["entityType = :project AND registeredBy = :registeredBy AND #definition.#revision = :projectRevision AND runtimeBinding.#deploymentMode = :deploymentMode AND runtimeBinding.#launchTemplateId = :launchTemplateId AND runtimeBinding.#volumeSizeGiB = :volumeSizeGiB AND runtimeBinding.#volumeType = :volumeType AND size(runtimeBinding.#subnets) = :subnetCount AND #setupApproval.proposalRef = :proposalRef AND #setupApproval.proposalSha256 = :proposalSha AND #setupApproval.candidateDigest = :candidateDigest AND #setupApproval.decision = :approve", ...projectSubnetConditions].join(" AND "),
      ExpressionAttributeNames: { "#definition": "definition", "#revision": "revision", "#deploymentMode": "deploymentMode", "#launchTemplateId": "launchTemplateId",
        "#volumeSizeGiB": "volumeSizeGiB", "#volumeType": "volumeType", "#subnets": "subnets", "#setupApproval": "setupApproval" },
      ExpressionAttributeValues: { ":project": "PROJECT", ":registeredBy": execution.ownerKey, ":projectRevision": execution.projectRevision,
        ":deploymentMode": "ec2-ebs", ":launchTemplateId": runtime.binding.launchTemplateId, ":volumeSizeGiB": runtime.binding.volumeSizeGiB, ":volumeType": runtime.binding.volumeType,
        ":subnetCount": runtime.binding.subnets.length, ":proposalRef": execution.proposalRef, ":proposalSha": execution.proposalSha256,
        ":candidateDigest": execution.candidateDigest, ":approve": "approve", ...projectSubnetValues },
    } },
    { ConditionCheck: {
      TableName: tableName,
      Key: { pk: `PROJECT_SETUP#${execution.projectName}`, sk: `PROPOSAL#${execution.proposalSha256}` },
      ConditionExpression: "entityType = :approval AND ownerKey = :ownerKey AND projectName = :projectName AND proposalRef = :proposalRef AND proposalSha256 = :proposalSha AND candidateDigest = :candidateDigest AND decision = :approve AND policyDigest = :policyDigest",
      ExpressionAttributeValues: { ":approval": "PROJECT_SETUP_APPROVAL", ":ownerKey": execution.ownerKey, ":projectName": execution.projectName,
        ":proposalRef": execution.proposalRef, ":proposalSha": execution.proposalSha256, ":candidateDigest": execution.candidateDigest,
        ":approve": "approve", ":policyDigest": execution.policyDigest },
    } },
    { ConditionCheck: {
      TableName: tableName,
      Key: projectSetupSessionKey(execution.setupExecutionId),
      ConditionExpression: "entityType = :session AND setupExecutionId = :setupExecutionId AND subjectId = :subjectId AND transportCorrelationId = :correlation AND approvalRevision = :approvalRevision AND bindingDigest = :bindingDigest AND #state = :ready AND generation = :generation",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: { ":session": "PROJECT_SETUP_SESSION", ":setupExecutionId": execution.setupExecutionId,
        ":subjectId": session.subjectId, ":correlation": session.transportCorrelationId, ":approvalRevision": session.approvalRevision,
        ":bindingDigest": session.bindingDigest, ":ready": "READY", ":generation": session.generation },
    } },
    { ConditionCheck: {
      TableName: tableName,
      Key: projectSetupRuntimeKey(execution.runtimeCatalogId, execution.bindingDigest),
      ConditionExpression: ["schemaVersion = :version AND entityType = :entityType AND runtimeCatalogId = :catalogId AND catalogRevision = :catalogRevision AND bindingDigest = :bindingDigest AND manifestDigest = :manifestDigest AND runnerEnvironmentDigest = :environmentDigest AND runnerToolchainDigest = :toolchainDigest AND endpoint = :endpoint AND generation = :generation AND transportCorrelationId = :correlation AND #state = :ready AND size(supportedSetupScopes) = :scopeCount AND contains(supportedSetupScopes, :scope) AND qualifiedAt = :qualifiedAt AND expiresAt = :expiresAt AND binding.#deploymentMode = :deploymentMode AND binding.#launchTemplateId = :launchTemplateId AND binding.#volumeSizeGiB = :volumeSizeGiB AND binding.#volumeType = :volumeType AND size(binding.#subnets) = :subnetCount AND runnerEnvironment.ci = :ci AND runnerEnvironment.trustNoticeShown = :trustNoticeShown AND runnerEnvironment.os = :os AND runnerEnvironment.arch = :environmentArch AND runnerEnvironment.runtime = :runtime AND runnerToolchain.execPath = :execPath AND runnerToolchain.version = :versionToolchain AND runnerToolchain.platform = :platform AND runnerToolchain.arch = :toolchainArch", ...subnetConditions].join(" AND "),
      ExpressionAttributeNames: { "#state": "state", "#deploymentMode": "deploymentMode", "#launchTemplateId": "launchTemplateId", "#volumeSizeGiB": "volumeSizeGiB", "#volumeType": "volumeType", "#subnets": "subnets" },
      ExpressionAttributeValues: {
        ":version": 1, ":entityType": "PROJECT_SETUP_RUNTIME", ":catalogId": execution.runtimeCatalogId,
        ":catalogRevision": execution.runtimeCatalogRevision, ":bindingDigest": execution.bindingDigest,
        ":manifestDigest": runtime.manifestDigest, ":environmentDigest": runtime.runnerEnvironmentDigest,
        ":toolchainDigest": runtime.runnerToolchainDigest, ":endpoint": runtime.endpoint,
        ":generation": execution.runtimeGeneration, ":correlation": execution.transportCorrelationId,
        ":ready": "READY", ":scope": "source-interface", ":scopeCount": 1, ":qualifiedAt": runtime.qualifiedAt, ":expiresAt": runtime.expiresAt,
        ":subnetCount": runtime.binding.subnets.length,
        ":deploymentMode": runtime.binding.deploymentMode, ":launchTemplateId": runtime.binding.launchTemplateId,
        ":volumeSizeGiB": runtime.binding.volumeSizeGiB, ":volumeType": runtime.binding.volumeType,
        ":ci": true, ":trustNoticeShown": false, ":os": runtime.runnerEnvironment.os, ":environmentArch": runtime.runnerEnvironment.arch,
        ":runtime": runtime.runnerEnvironment.runtime, ":execPath": runtime.runnerToolchain.execPath, ":versionToolchain": runtime.runnerToolchain.version,
        ":platform": runtime.runnerToolchain.platform, ":toolchainArch": runtime.runnerToolchain.arch,
        ...subnetValues,
      },
    } },
  ];
}
