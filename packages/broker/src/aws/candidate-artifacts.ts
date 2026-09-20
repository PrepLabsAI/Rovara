import { createHash } from "node:crypto";
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { CANDIDATE_CHUNK_BYTES, candidateArtifactId, agentXError, type CandidateResult } from "@agentx/contracts";
import type { ExpectedCandidateBinding } from "../candidate-bindings.js";

interface Dependencies {
  documentClient: DynamoDBDocumentClient;
  s3: S3Client;
  tableName: string;
  artifactBucketName: string;
}
interface CandidateOperation {
  id: string;
  workspaceId: string;
  createdAt: string;
  fence: number;
  candidateBinding?: ExpectedCandidateBinding;
}
interface ArtifactRecord {
  pk: string; sk: string; entityType: "ARTIFACT";
  id: string; workspaceId: string; operationId: string; ownerKey: string;
  name: string; mediaType: string; objectKey: string;
  sha256: string; sizeBytes: number; decodedSha256: string; decodedSizeBytes: number;
  createdAt: string; expiresAt: string;
}
const mediaType = "application/vnd.agentx.git-bundle-chunk.base64";
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export async function putCandidateArtifact(
  dependencies: Dependencies, operation: CandidateOperation, ownerKey: string, input: Record<string, unknown>,
): Promise<{ artifactId: string; sha256: string; sizeBytes: number }> {
  if (!operation.candidateBinding || Object.keys(input).some((key) => !["id", "name", "mediaType", "content"].includes(key)) ||
      typeof input.name !== "string" || typeof input.content !== "string" || input.mediaType !== mediaType) {
    throw agentXError("CALLBACK_FORBIDDEN", "operation cannot upload a candidate artifact");
  }
  const match = /^candidate-([0-9a-f-]{36})-([0-9]{4})\.bundle\.base64$/.exec(input.name);
  if (!match || match[1] !== operation.id || Number(match[2]) >= 32 || input.id !== candidateArtifactId(operation.id, input.name)) {
    throw agentXError("CALLBACK_FORBIDDEN", "candidate chunk identity is outside the operation scope");
  }
  const bytes = decodeChunk(input.content);
  const id = input.id;
  const key = { pk: `WORKSPACE#${operation.workspaceId}`, sk: `ARTIFACT#${id}` };
  const objectKey = `private/${ownerKey}/${operation.workspaceId}/${operation.id}/${id}`;
  const hash = sha(input.content);
  const sizeBytes = Buffer.byteLength(input.content);
  const record: ArtifactRecord = { ...key, entityType: "ARTIFACT", id, workspaceId: operation.workspaceId,
    operationId: operation.id, ownerKey, name: input.name, mediaType, objectKey, sha256: hash, sizeBytes,
    decodedSha256: sha(bytes), decodedSizeBytes: bytes.length, createdAt: new Date().toISOString(),
    // Logical access expiry; no promise that bucket deletion occurs at this instant.
    expiresAt: new Date(Date.parse(operation.createdAt) + 48 * 3_600_000).toISOString() };
  const existing = await getRecord(dependencies, key);
  if (existing && !sameArtifact(existing, record)) throw agentXError("IDEMPOTENCY_CONFLICT", "candidate artifact is immutable");
  if (!existing) {
    try {
      await dependencies.s3.send(new PutObjectCommand({ Bucket: dependencies.artifactBucketName, Key: objectKey,
        Body: input.content, ContentType: mediaType, IfNoneMatch: "*" }));
    } catch (error) {
      // Lost acknowledgement / crash before metadata: compare stored bytes; never overwrite.
      if (!(error && typeof error === "object" && "name" in error && ["PreconditionFailed", "ConditionalRequestConflict"].includes(String(error.name)))) throw error;
    }
  }
  await readBack(dependencies, record);
  if (!existing) {
    try {
      await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
        { ConditionCheck: { TableName: dependencies.tableName, Key: { pk: `WORKSPACE#${operation.workspaceId}`, sk: "META" },
          ConditionExpression: "activeOperationId = :operation AND fence = :fence", ExpressionAttributeValues: { ":operation": operation.id, ":fence": operation.fence } } },
        { Put: { TableName: dependencies.tableName, Item: record, ConditionExpression: "attribute_not_exists(pk)" } },
      ] }));
    } catch (error) {
      const concurrent = await getRecord(dependencies, key);
      if (!concurrent || !sameArtifact(concurrent, record)) throw error;
    }
  }
  return { artifactId: id, sha256: hash, sizeBytes };
}

export async function validateStoredCandidateArtifacts(
  dependencies: Dependencies, operation: CandidateOperation, candidate: CandidateResult,
): Promise<void> {
  const now = Date.now();
  if (Date.parse(candidate.createdAt) < Date.parse(operation.createdAt) || Date.parse(candidate.createdAt) > now ||
      Date.parse(candidate.expiresAt) <= now || Date.parse(candidate.expiresAt) > Date.parse(candidate.createdAt) + 86_400_000 ||
      Date.parse(candidate.expiresAt) > Date.parse(operation.createdAt) + 48 * 3_600_000) {
    throw agentXError("CONFIG_INVALID", "candidate retention or creation time is invalid");
  }
  const bundleHash = createHash("sha256");
  for (const chunk of candidate.retrieval.chunks) {
    if (chunk.artifactId !== candidateArtifactId(operation.id, chunk.name)) throw agentXError("CALLBACK_FORBIDDEN", "candidate artifact identity mismatch");
    const record = await getRecord(dependencies, { pk: `WORKSPACE#${operation.workspaceId}`, sk: `ARTIFACT#${chunk.artifactId}` });
    if (!record || record.operationId !== operation.id || record.workspaceId !== operation.workspaceId || record.name !== chunk.name ||
        record.mediaType !== mediaType || record.decodedSha256 !== chunk.sha256 || record.decodedSizeBytes !== chunk.sizeBytes ||
        Date.parse(record.expiresAt) < Date.parse(candidate.expiresAt)) {
      throw agentXError("CONFIG_INVALID", "candidate artifact is missing or does not match its retained receipt");
    }
    bundleHash.update(decodeChunk(await readBack(dependencies, record)));
  }
  if (bundleHash.digest("hex") !== candidate.retrieval.sha256) throw agentXError("CONFIG_INVALID", "candidate bundle digest mismatch");
}

function decodeChunk(content: string): Buffer {
  if (content.length === 0 || content.length > Math.ceil(CANDIDATE_CHUNK_BYTES / 3) * 4) throw agentXError("CONFIG_INVALID", "candidate chunk size exceeds limit");
  const bytes = Buffer.from(content, "base64");
  if (bytes.length === 0 || bytes.length > CANDIDATE_CHUNK_BYTES || bytes.toString("base64") !== content) throw agentXError("CONFIG_INVALID", "candidate chunk is not bounded canonical base64");
  return bytes;
}

async function getRecord(dependencies: Dependencies, key: { pk: string; sk: string }): Promise<ArtifactRecord | undefined> {
  const response = await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.tableName, Key: key, ConsistentRead: true }));
  return response.Item as ArtifactRecord | undefined;
}

function sameArtifact(left: ArtifactRecord, right: ArtifactRecord): boolean {
  return ["id", "workspaceId", "operationId", "ownerKey", "name", "mediaType", "objectKey", "sha256", "sizeBytes", "decodedSha256", "decodedSizeBytes", "expiresAt"]
    .every((key) => left[key as keyof ArtifactRecord] === right[key as keyof ArtifactRecord]);
}

async function readBack(dependencies: Dependencies, record: ArtifactRecord): Promise<string> {
  const stored = await dependencies.s3.send(new GetObjectCommand({ Bucket: dependencies.artifactBucketName, Key: record.objectKey }));
  const content = await stored.Body?.transformToString("utf8");
  if (content === undefined || Buffer.byteLength(content) !== record.sizeBytes || sha(content) !== record.sha256) {
    throw agentXError("RUNTIME_UNAVAILABLE", "candidate artifact readback integrity mismatch");
  }
  return content;
}
