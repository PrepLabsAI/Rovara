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
      ConditionExpression: "entityType = :project AND registeredBy = :registeredBy AND #definition.#revision = :projectRevision AND #runtimeBinding = :binding AND #setupApproval.proposalRef = :proposalRef AND #setupApproval.proposalSha256 = :proposalSha AND #setupApproval.candidateDigest = :candidateDigest AND #setupApproval.decision = :approve",
      ExpressionAttributeNames: { "#definition": "definition", "#revision": "revision", "#runtimeBinding": "runtimeBinding", "#setupApproval": "setupApproval" },
      ExpressionAttributeValues: { ":project": "PROJECT", ":registeredBy": execution.ownerKey, ":projectRevision": execution.projectRevision,
        ":binding": runtime.binding, ":proposalRef": execution.proposalRef, ":proposalSha": execution.proposalSha256,
        ":candidateDigest": execution.candidateDigest, ":approve": "approve" },
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
      ConditionExpression: "schemaVersion = :version AND entityType = :entityType AND runtimeCatalogId = :catalogId AND catalogRevision = :catalogRevision AND bindingDigest = :bindingDigest AND manifestDigest = :manifestDigest AND runnerEnvironmentDigest = :environmentDigest AND runnerToolchainDigest = :toolchainDigest AND endpoint = :endpoint AND generation = :generation AND transportCorrelationId = :correlation AND #state = :ready AND #supportedSetupScopes = :supportedSetupScopes AND qualifiedAt = :qualifiedAt AND expiresAt = :expiresAt AND #binding = :binding AND #runnerEnvironment = :runnerEnvironment AND #runnerToolchain = :runnerToolchain",
      ExpressionAttributeNames: { "#state": "state", "#supportedSetupScopes": "supportedSetupScopes", "#binding": "binding", "#runnerEnvironment": "runnerEnvironment", "#runnerToolchain": "runnerToolchain" },
      ExpressionAttributeValues: {
        ":version": 1, ":entityType": "PROJECT_SETUP_RUNTIME", ":catalogId": execution.runtimeCatalogId,
        ":catalogRevision": execution.runtimeCatalogRevision, ":bindingDigest": execution.bindingDigest,
        ":manifestDigest": runtime.manifestDigest, ":environmentDigest": runtime.runnerEnvironmentDigest,
        ":toolchainDigest": runtime.runnerToolchainDigest, ":endpoint": runtime.endpoint,
        ":generation": execution.runtimeGeneration, ":correlation": execution.transportCorrelationId,
        ":ready": "READY", ":supportedSetupScopes": runtime.supportedSetupScopes, ":qualifiedAt": runtime.qualifiedAt, ":expiresAt": runtime.expiresAt,
        ":binding": runtime.binding, ":runnerEnvironment": runtime.runnerEnvironment, ":runnerToolchain": runtime.runnerToolchain,
      },
    } },
  ];
}
