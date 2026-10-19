import { createHash } from "node:crypto";
import { runtimeInstallChallengeDigest, type RuntimeInstallChallenge } from "../../packages/contracts/src/index.js";
import type { RuntimeInstallationDependencies } from "../../packages/broker/src/aws/runtime-installation.js";

/**
 * An in-memory datastore and object store for the runtime registrar: the items, the retained objects and every transaction it sent, with the
 * one issued challenge row a registration consumes. Nothing here is a real AWS client.
 */
export function createFakeRuntimeRegistry(at: number) {
  const items = new Map<string, Record<string, unknown>>();
  const objects = new Map<string, Buffer>();
  const transactions: Array<Array<Record<string, unknown>>> = [];
  const k = (key: Record<string, unknown>) => `${String(key.pk)}|${String(key.sk)}`;
  const documentClient = { send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const { input } = command;
    if (command.constructor.name === "GetCommand") return { Item: items.get(k(input.Key as Record<string, unknown>)) };
    if (command.constructor.name === "PutCommand") { items.set(k(input.Item as Record<string, unknown>), input.Item as Record<string, unknown>); return {}; }
    if (command.constructor.name === "TransactWriteCommand") {
      const writes = input.TransactItems as Array<Record<string, { Item?: Record<string, unknown>; Key?: Record<string, unknown> }>>;
      transactions.push(writes);
      for (const write of writes) {
        if (write.Put?.Item) items.set(k(write.Put.Item), write.Put.Item);
        if (write.Update?.Key) items.set(k(write.Update.Key), { ...items.get(k(write.Update.Key))!, state: "CONSUMED" });
      }
      return {};
    }
    throw new Error(`unexpected datastore command ${command.constructor.name}`);
  } };
  const s3 = { send: async (command: { constructor: { name: string }; input: { Key: string; Body?: Buffer } }) => {
    if (command.constructor.name === "PutObjectCommand") { objects.set(command.input.Key, Buffer.from(command.input.Body!)); return {}; }
    throw new Error("unexpected object-store command");
  } };
  const deps = { documentClient, s3, tableName: "state", artifactBucketName: "artifacts", setupCatalogId: "configured-setup", featureCatalogId: "configured-feature", now: () => at } as unknown as RuntimeInstallationDependencies;
  /** The row `issueRuntimeInstallChallenge` writes for this challenge, so a registration of a proposal answering it can consume it. */
  const seedChallenge = (challenge: RuntimeInstallChallenge) => {
    items.set(`RUNTIME_INSTALL_CHALLENGE#${challenge.challengeId}|CHALLENGE`, { pk: `RUNTIME_INSTALL_CHALLENGE#${challenge.challengeId}`, sk: "CHALLENGE",
      entityType: "RUNTIME_INSTALL_CHALLENGE", state: "ISSUED", challengeDigest: runtimeInstallChallengeDigest(challenge),
      secretSha256: createHash("sha256").update(Buffer.from(challenge.challengeSecret, "base64")).digest("hex"), issuedByOwnerKey: challenge.issuedByOwnerKey, issuedBySubject: challenge.issuedBySubject,
      issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt });
  };
  return { deps, items, objects, transactions, seedChallenge };
}
