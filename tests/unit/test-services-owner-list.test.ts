// Test services on a laptop, from the owner's own approved image list (owner decision 2026-11-11): the starter list, one-time approval with the digest pinned, the env list, what a repository only PROPOSES, and the signed
// catalog still winning where a build has a key. The page's own checks (a fresh session, a single-use form) are in local-up-service-images.test.ts; the guard's list in local-test-services-guard.test.ts.
import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CATALOG_SIGNATURE_ALGORITHM, IMPLICIT_COMPANY_ID, OWNER_IMAGE_REFUSALS, ServiceCatalogSchema, catalogSigningKeysCompiledIn, OWNER_STARTER_IMAGES, OwnerServiceImageSchema, catalogSigningMessage, checkMirrorServesDigest, describeImage, isOwnerListCatalog, normalizeOwnerList,
  ownerCatalogOf, ownerImageReferences, ownerImageRequest, ownerListReferences, ownerStarterEntries, parseBundlePublicKey, parseImageReference, resolveCatalogImage, sha256HexOf, starterImageFor,
  type OwnerListEntry, type TestEnvDependencyCandidate,
} from "@agentx/contracts";
import { loadSignedCatalogWith } from "../../packages/contracts/dist/catalog-load-core.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { prepareLocalTestServices } from "../../packages/broker/src/local/test-services-install.js";
import { localTestServicesDigestPart, testServicesEnvironment } from "../../packages/broker/src/local/test-services.js";
import {
  NO_IMAGES_SENTENCE, createOwnerImageService, createOwnerImageStore, pinImageThroughDocker, proposeServiceImages, resolveOwnerImages, type OwnerImageService,
} from "../../packages/broker/src/local/test-services-owner-list.js";
import { OwnerDocker, sha } from "../support/owner-docker.js";
import { pinnedCatalog, verifiedCatalog } from "../support/catalog-pinning.js";

const COMPANY = IMPLICIT_COMPANY_ID;
const ON = { ROVARA_TEST_SERVICES: "1" };
const PG15 = "docker.io/library/postgres:15";
const digestOf = (label: string): string => sha(`digest:${label}`);
const pg15 = (label: string): string => `docker.io/library/postgres@sha256:${digestOf(label)}`;

function setup(now = 1_800_000_000_000) {
  const docker = new OwnerDocker();
  const documents = new MemoryDocumentStore({ indexes: [] });
  const store = createOwnerImageStore({ store: documents, companyId: COMPANY });
  const audited: string[] = [];
  let clock = now;
  const service = createOwnerImageService({
    store, docker, now: () => clock, companyId: COMPANY, audit: { stage: () => [], record: async (event) => { audited.push(event.action); } },
  });
  return { docker, documents, store, service, audited, tick: (ms: number) => { clock += ms; } };
}
const install = (h: ReturnType<typeof setup>, environment: NodeJS.ProcessEnv = ON, extra: Record<string, unknown> = {}) =>
  prepareLocalTestServices({ environment, stateDirectory: "/nowhere", docker: h.docker, ownerImages: h.service, interfaces: {}, ...extra });

const candidate = (family: string, version: string | undefined, at = 4): TestEnvDependencyCandidate => ({
  family, kind: family === "redis" ? "cache" : "database", evidence: [{ path: "docker-compose.yml", line: at }], strength: "declared", hints: { ...(version === undefined ? {} : { version }) },
});

describe("an image reference, read the way Docker reads it", () => {
  it("puts a bare name on Docker Hub's library, keeps a registry host, and refuses anything that is not a plain lower-case name", () => {
    expect(parseImageReference("postgres:16")).toEqual({ registry: "docker.io", repository: "library/postgres", tag: "16" });
    expect(parseImageReference("ghcr.io/org/pg:1.2")).toEqual({ registry: "ghcr.io", repository: "org/pg", tag: "1.2" });
    expect(parseImageReference("localhost:5000/pg:1")).toMatchObject({ registry: "localhost:5000", repository: "pg" });
    expect(parseImageReference(`postgres@sha256:${"a".repeat(64)}`)).toMatchObject({ repository: "library/postgres", digest: "a".repeat(64) });
    for (const bad of ["", "Postgres:16", "postgres:16 ", "https://x/y:1", "user:pw@host/x:1", "postgres@sha256:abc", "postgres:", "a b", "postgres\n:16", "x".repeat(400), "../x:1"]) expect(parseImageReference(bad), bad).toBeUndefined();
    expect(describeImage(parseImageReference("postgres:16")!)).toBe("postgres:16 from Docker Hub");
    expect(describeImage(parseImageReference("ghcr.io/org/postgres:16")!)).toBe("org/postgres:16 from ghcr.io");
  });

  it("approves only a tag with a version, of a family Rovara has a profile for", () => {
    expect(ownerImageRequest("postgres:16.4-alpine")).toMatchObject({ ok: true, family: "postgres", version: "16.4" });
    expect(ownerImageRequest("valkey/valkey:8")).toMatchObject({ ok: true, family: "redis", version: "8" });
    expect(ownerImageRequest("mongo:7")).toMatchObject({ ok: true, family: "mongodb", version: "7" });
    expect(ownerImageRequest("postgres")).toMatchObject({ ok: false, reason: "no_tag" });
    expect(ownerImageRequest("postgres:latest")).toMatchObject({ ok: false, reason: "no_version" });
    expect(ownerImageRequest(`postgres@sha256:${"a".repeat(64)}`)).toMatchObject({ ok: false, reason: "has_digest" });
    expect(ownerImageRequest("alpine:3.20")).toMatchObject({ ok: false, reason: "unsupported_family" });
    expect(ownerImageRequest("Postgres:16")).toMatchObject({ ok: false, reason: "not_a_reference" });
  });
});

describe("the built-in starter list", () => {
  it("is exactly Postgres 16 and 17, MySQL 8, Redis 7 and MongoDB 7, from Docker Hub's library, each pinned to a digest, with where it came from", () => {
    expect(OWNER_STARTER_IMAGES.map((image) => image.requested).sort()).toEqual(["mongo:7", "mysql:8", "postgres:16", "postgres:17", "redis:7"]);
    for (const image of OWNER_STARTER_IMAGES) {
      expect(image.reference).toMatch(/^docker\.io\/library\/(postgres|mysql|redis|mongo)@sha256:[a-f0-9]{64}$/u);
      expect(parseImageReference(image.requested)!.repository).toBe(parseImageReference(image.reference)!.repository);
      expect(image.source).toMatch(/registry-1\.docker\.io on 2026-11-11.*linux\/arm64 and linux\/amd64/u);
    }
    expect(new Set(OWNER_STARTER_IMAGES.map((image) => image.reference)).size).toBe(5);
    expect(starterImageFor("postgres", "16.4")?.requested).toBe("postgres:16");
    expect(starterImageFor("postgres", "15")).toBeUndefined();
  });

  it("makes a catalog the broker, the worker and the guard share: one entry per image, digest-pinned, with no SBOM or scan, marked as an owner list", () => {
    const catalog = ownerCatalogOf(ownerStarterEntries())!;
    expect(catalog.entries.map((entry) => entry.id).sort()).toEqual(["mongodb@7", "mysql@8", "postgres@16", "postgres@17", "redis@7"]);
    expect(catalog.entries.find((entry) => entry.id === "postgres@17")!.status).toBe("default");
    expect(catalog.entries.find((entry) => entry.id === "postgres@16")!.status).toBe("available");
    for (const entry of catalog.entries) {
      expect(entry).toMatchObject({ backing: "local", ownerApproved: true, editions: ["public"], run: { user: "999:999", readOnlyRoot: true } });
      expect(entry.image.digest).toMatch(/^[a-f0-9]{64}$/u);
      expect(entry.sbomRef).toBeUndefined();
      expect(entry.scan).toBeUndefined();
    }
    expect(isOwnerListCatalog(catalog)).toBe(true);
    expect(ownerCatalogOf([])).toBeUndefined();
    expect(ownerListReferences(ownerStarterEntries())).toHaveLength(5);
  });

  it("is never replaced by another image of the same family and version: the starter comes first and wins", () => {
    const other: OwnerListEntry = { reference: pg15("x").replace("postgres", "postgres"), family: "postgres", version: "16" };
    const list = normalizeOwnerList([...ownerStarterEntries(), other]);
    expect(list.filter((entry) => entry.family === "postgres" && entry.version === "16").map((entry) => entry.reference)).toEqual([OWNER_STARTER_IMAGES[0]!.reference]);
  });

  it("takes only a reference written as registry, repository and digest: a tag beside the digest, a short form or an unknown family is not an entry", () => {
    const digest = "a".repeat(64);
    const entry = (reference: string, family = "postgres"): unknown => ({ reference, family, version: "16" });
    expect(normalizeOwnerList([entry(`docker.io/library/postgres@sha256:${digest}`)])).toHaveLength(1);
    for (const bad of [entry(`docker.io/library/postgres:16@sha256:${digest}`), entry(`postgres@sha256:${digest}`), entry("docker.io/library/postgres:16"), entry(`docker.io/library/alpine@sha256:${digest}`), entry(`docker.io/library/postgres@sha256:${digest}`, "mysql"), entry(`docker.io/library/postgres@sha256:${digest}`, "kafka")]) {
      expect(normalizeOwnerList([bad])).toEqual([]);
    }
  });

  it("is a guard file: the port guard flags a change to it", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("scripts/port-guard.ts", "utf8")).toContain("owner-starter-images");
    expect(readFileSync("packages/contracts/src/owner-starter-images.ts", "utf8")).toContain("THIS FILE IS A GUARD FILE");
  });
});

describe("an owner-list catalog is never a signed one", () => {
  const signed = (catalog: unknown) => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const catalogBytes = Buffer.from(JSON.stringify(catalog), "utf8");
    const signature = createSign("sha256").update(catalogSigningMessage(catalogBytes)).sign({ key: privateKey, dsaEncoding: "der" }).toString("base64");
    const signatureBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, algorithm: CATALOG_SIGNATURE_ALGORITHM, keyId: parseBundlePublicKey(pem).keyId, catalogSha256: sha256HexOf(catalogBytes), signature }), "utf8");
    return loadSignedCatalogWith({ catalogBytes, signatureBytes }, [pem]);
  };

  it("a signed file that carries an owner-approved entry does not load, however it is signed", () => {
    const fromOwner = JSON.parse(JSON.stringify(ownerCatalogOf(ownerStarterEntries()))) as unknown;
    expect(signed(fromOwner)).toMatchObject({ ok: false, reason: expect.stringContaining("owner-approved") as unknown });
    // The same file as a release would sign it (no owner flag) still loads: it is the flag that is refused.
    expect(signed(pinnedCatalog()).ok).toBe(true);
  });

  it("the signed-catalog image rule (Cloud's) refuses an owner-list catalog even with a good registry check", async () => {
    const bytes = Buffer.from("manifest");
    const digest = sha256HexOf(bytes);
    const owner = ownerCatalogOf([{ reference: `docker.io/library/postgres@sha256:${digest}`, family: "postgres", version: "16" }])!;
    const check = await checkMirrorServesDigest({ manifestBytes: async () => bytes }, { id: "postgres@16", repositoryName: "rovara-catalog/local/svc/postgres", digest });
    expect(check).toMatchObject({ ok: true });
    const approvals = { find: async () => undefined };
    expect(await resolveCatalogImage({ catalog: owner, catalogId: "postgres@16", edition: "public", served: { source: "rovara_registry", check }, approvals })).toMatchObject({ ok: false, code: "not_verified" });
    // The same entry in a signed catalog resolves: the refusal is the owner brand and nothing else.
    const signedCatalog = verifiedCatalog(pinnedCatalog((entries) => { const postgres = entries.find((entry) => entry["id"] === "postgres@16")!; (postgres["image"] as { digest: string }).digest = digest; }));
    expect(await resolveCatalogImage({ catalog: signedCatalog, catalogId: "postgres@16", edition: "public", served: { source: "rovara_registry", check }, approvals })).toMatchObject({ ok: true });
  });
});

describe("a starter image is served with no approval", () => {
  it("pulls each starter by its digest, lists exactly those for the guard and the worker, and builds the catalog from them", async () => {
    const h = setup();
    const result = await install(h);
    expect(result.mode).toBe("owner");
    expect(result.unavailable).toBeUndefined();
    const starterRefs = OWNER_STARTER_IMAGES.map((image) => image.reference).sort();
    expect([...result.services!.images].sort()).toEqual(starterRefs);
    expect(h.docker.pulls().sort()).toEqual(starterRefs);
    expect(h.docker.pulls().every((name) => name.includes("@sha256:"))).toBe(true);
    expect(result.catalog!.entries.map((entry) => entry.id).sort()).toEqual(["mongodb@7", "mysql@8", "postgres@16", "postgres@17", "redis@7"]);
    expect(await result.catalogSource!()).toBe(result.catalog);
    // The worker is told the same list, and no registry.
    const environment = testServicesEnvironment(result.services!, { runDirectory: "/run/x", workerImageId: `sha256:${"a".repeat(64)}` });
    expect(JSON.parse(environment["AGENTX_TEST_SERVICES_OWNER_IMAGES"]!)).toHaveLength(5);
    expect(environment["AGENTX_TEST_SERVICES_REGISTRY"]).toBe("owner-list.invalid");
    expect(h.audited).toEqual([]);
    expect(await h.service.list()).toEqual([]);
  });

  it("uses an image that is already on this computer without pulling it", async () => {
    const h = setup();
    for (const image of OWNER_STARTER_IMAGES) h.docker.held.add(image.reference);
    const result = await install(h);
    expect(result.services!.images).toHaveLength(5);
    expect(h.docker.pulls()).toEqual([]);
  });

  it("leaves out a starter that cannot be pulled, and says how to approve images when none can", async () => {
    const h = setup();
    h.docker.failing.add("library/mysql");
    const some = await install(h);
    expect(some.services!.images).toHaveLength(4);
    expect(some.catalog!.entries.some((entry) => entry.family === "mysql")).toBe(false);
    const none = setup();
    none.docker.reachable = false;
    const result = await install(none);
    expect(result).toMatchObject({ services: undefined, catalog: undefined, unavailable: NO_IMAGES_SENTENCE, mode: "owner" });
    expect(NO_IMAGES_SENTENCE).toContain("test environment page");
    expect(NO_IMAGES_SENTENCE).toContain("ROVARA_TEST_SERVICE_IMAGES");
    // The owner's list is still handed back, so the page can approve an image.
    expect(result.ownerImages).toBe(none.service);
  });

  it("is off, and touches nothing, with test services off", async () => {
    const h = setup();
    expect(await install(h, {})).toEqual({ services: undefined, catalog: undefined, unavailable: undefined });
    expect(h.docker.calls).toEqual([]);
  });
});

describe("an image that is not on the starter list needs the owner's one-time approval", () => {
  it("is not started before it is approved, is pulled and pinned to the digest Docker resolves when it is, and is used from the next start", async () => {
    const h = setup();
    h.docker.tags.set(PG15, digestOf("a"));
    const before = await install(h);
    expect(before.services!.images.some((image) => image.includes("postgres@sha256:" + digestOf("a")))).toBe(false);
    expect(before.catalog!.entries.some((entry) => entry.id === "postgres@15")).toBe(false);

    const approval = await h.service.approve({ requested: "postgres:15", project: "payments" });
    expect(approval).toMatchObject({ ok: true, image: { reference: pg15("a"), family: "postgres", version: "15", requested: "postgres:15", origin: "page", project: "payments" } });
    expect(h.docker.pulls().at(-1)).toBe(PG15);
    expect(h.audited).toEqual(["test_services.image_approved"]);
    expect(OwnerServiceImageSchema.safeParse((await h.service.list())[0]).success).toBe(true);

    const after = await install(h);
    expect(after.services!.images).toContain(pg15("a"));
    expect(after.catalog!.entries.find((entry) => entry.id === "postgres@15")!.image.digest).toBe(digestOf("a"));
    expect(after.services!.images).toHaveLength(6);
  });

  it("pins the digest: a moved tag changes nothing until the owner approves again", async () => {
    const h = setup();
    h.docker.tags.set(PG15, digestOf("a"));
    await h.service.approve({ requested: "postgres:15" });
    h.docker.tags.set(PG15, digestOf("b"));
    const started = await install(h);
    expect(started.services!.images).toContain(pg15("a"));
    expect(started.services!.images).not.toContain(pg15("b"));
    expect(h.docker.pulls().filter((name) => name === PG15)).toHaveLength(1);
    // Approving again takes the new digest, and replaces the old one.
    expect(await h.service.approve({ requested: "postgres:15" })).toMatchObject({ ok: true, image: { reference: pg15("b") } });
    const again = await install(h);
    expect(again.services!.images).toContain(pg15("b"));
    expect(again.services!.images).not.toContain(pg15("a"));
    expect(await h.service.list()).toHaveLength(1);
  });

  it("refuses what is not an approvable tag, an image Docker cannot pull, and a digest Docker does not report, and stores nothing", async () => {
    const h = setup();
    expect(await h.service.approve({ requested: "postgres" })).toMatchObject({ ok: false, reason: "refused" });
    expect(await h.service.approve({ requested: "postgres:latest" })).toMatchObject({ ok: false, reason: "refused" });
    expect(await h.service.approve({ requested: "alpine:3.20" })).toMatchObject({ ok: false, reason: "refused" });
    expect(await h.service.approve({ requested: `postgres@sha256:${"a".repeat(64)}` })).toMatchObject({ ok: false, reason: "refused" });
    expect(h.docker.pulls()).toEqual([]);
    expect(await h.service.approve({ requested: "postgres:15" })).toMatchObject({ ok: false, reason: "pin_failed" });
    expect(await h.service.list()).toEqual([]);
    expect(await pinImageThroughDocker({ run: async (args) => (args[0] === "pull" ? { exitCode: 0, stdout: "", stderr: "" } : { exitCode: 0, stdout: "[]\n", stderr: "" }) }, { registry: "docker.io", repository: "library/postgres", tag: "15" })).toEqual({ ok: false, reason: "no_digest" });
    const two = await pinImageThroughDocker({ run: async (args) => (args[0] === "pull" ? { exitCode: 0, stdout: "", stderr: "" } : { exitCode: 0, stdout: JSON.stringify([`postgres@sha256:${"a".repeat(64)}`, `postgres@sha256:${"b".repeat(64)}`]), stderr: "" }) }, { registry: "docker.io", repository: "library/postgres", tag: "15" });
    expect(two).toEqual({ ok: false, reason: "ambiguous" });
    // A digest that Docker reports for ANOTHER repository is not this image's.
    const other = await pinImageThroughDocker({ run: async (args) => (args[0] === "pull" ? { exitCode: 0, stdout: "", stderr: "" } : { exitCode: 0, stdout: JSON.stringify([`evil/postgres@sha256:${"a".repeat(64)}`]), stderr: "" }) }, { registry: "docker.io", repository: "library/postgres", tag: "15" });
    expect(other).toEqual({ ok: false, reason: "no_digest" });
  });

  it("a starter name with a different digest is refused: no approval takes a starter's place", async () => {
    const h = setup();
    h.docker.tags.set("docker.io/library/postgres:16", digestOf("newer"));
    const refused = await h.service.approve({ requested: "postgres:16" });
    expect(refused).toMatchObject({ ok: false, reason: "builtin" });
    expect(h.docker.pulls()).toEqual([]);
    expect(await h.service.list()).toEqual([]);
    // Nor does one sneak in by the env list, even written with a digest of its own.
    const env = { ...ON, ROVARA_TEST_SERVICE_IMAGES: `postgres:16@sha256:${digestOf("newer")},postgres:16` };
    const started = await install(h, env);
    expect(started.services!.images).toContain(OWNER_STARTER_IMAGES[0]!.reference);
    expect(started.services!.images.some((image) => image.includes(digestOf("newer")))).toBe(false);
    expect(h.docker.calls.some((call) => call.at(-1)!.includes(digestOf("newer")))).toBe(false);
  });
});

describe("ROVARA_TEST_SERVICE_IMAGES", () => {
  it("pins a tag the first time it is pulled, keeps that pin when the tag moves, shows it, and forgets it once it is no longer listed", async () => {
    const h = setup();
    h.docker.tags.set(PG15, digestOf("a"));
    const env = { ...ON, ROVARA_TEST_SERVICE_IMAGES: "postgres:15" };
    const first = await install(h, env);
    expect(first.services!.images).toContain(pg15("a"));
    expect(await h.service.list()).toMatchObject([{ reference: pg15("a"), origin: "env", requested: "postgres:15" }]);
    h.docker.tags.set(PG15, digestOf("b"));
    const second = await install(h, env);
    expect(second.services!.images).toContain(pg15("a"));
    expect(h.docker.pulls().filter((name) => name === PG15)).toHaveLength(1);
    expect((await h.service.view()).owned[0]).toMatchObject({ origin: "env", inEffect: true, stale: false });
    // Not listed any more: the pin is dropped, so listing it again pins afresh.
    const third = await install(h, ON);
    expect(third.services!.images).not.toContain(pg15("a"));
    expect(await h.service.list()).toEqual([]);
    const fourth = await install(h, env);
    expect(fourth.services!.images).toContain(pg15("b"));
  });

  it("takes a name:tag@digest entry as written, ignores entries it cannot read or that are not a supported family, and stays within sixteen", async () => {
    const h = setup();
    const env = { ...ON, ROVARA_TEST_SERVICE_IMAGES: `postgres:15@sha256:${digestOf("c")}, alpine:3.20 ,not an image, Postgres:15, ` };
    const started = await install(h, env);
    expect(started.services!.images).toContain(pg15("c"));
    expect(started.services!.images).toHaveLength(6);
    expect(h.docker.pulls()).toContain(pg15("c"));
  });
});

describe("what a repository asks for is only a proposal", () => {
  it("turns candidates into official images of a family and version, and approves, pulls and stores nothing", async () => {
    const h = setup();
    const proposed = proposeServiceImages([candidate("postgres", "15"), candidate("postgres", "15", 9), candidate("redis", "7"), candidate("mongodb", "7"), candidate("mysql", undefined), candidate("kafka", "3"), candidate("aws:s3", undefined)]);
    expect(proposed.map((entry) => entry.requested)).toEqual(["mongo:7", "postgres:15", "redis:7"]);
    expect(proposed.find((entry) => entry.requested === "postgres:15")!.evidence).toEqual([{ path: "docker-compose.yml", line: 4 }, { path: "docker-compose.yml", line: 9 }]);
    expect(h.docker.calls).toEqual([]);
    expect(await h.service.list()).toEqual([]);
    expect(h.audited).toEqual([]);
    // Starting from the install, nothing that was proposed is in effect.
    const started = await install(h);
    expect(started.catalog!.entries.some((entry) => entry.id === "postgres@15")).toBe(false);
    expect(started.services!.images.some((image) => image.includes("postgres@sha256:" + digestOf("a")))).toBe(false);
  });

  it("checks the version shape itself (1 to 3 digits) and only ever proposes Docker Hub's official image, whatever the draft schema lets through", () => {
    const withVersion = (version: string): TestEnvDependencyCandidate => ({ ...candidate("postgres", "16"), hints: { version } });
    for (const hostile of ["5432/evil/postgres:16", "16.4", "16-alpine", "1234", "", "latest", "16\n", "1/2"]) expect(proposeServiceImages([withVersion(hostile)]), hostile).toEqual([]);
    const proposed = proposeServiceImages([candidate("postgres", "16"), candidate("mysql", "8"), candidate("redis", "7"), candidate("mongodb", "7")]);
    expect(proposed.map((entry) => entry.requested)).toEqual(["mongo:7", "mysql:8", "postgres:16", "redis:7"]);
    for (const entry of proposed) expect(parseImageReference(entry.requested)).toMatchObject({ registry: "docker.io", repository: expect.stringMatching(/^library\/(mongo|mysql|postgres|redis)$/u) as unknown });
  });

  it("copies no repository text: an image name in a hint is not one the proposal can carry", () => {
    const hostile = { ...candidate("postgres", "16"), hints: { version: "16", url: { scheme: "postgres", hostFamily: "unknown" } }, evidence: [{ path: "evil.example/postgres:16", line: 1 }] } as TestEnvDependencyCandidate;
    expect(proposeServiceImages([hostile]).map((entry) => entry.requested)).toEqual(["postgres:16"]);
  });
});

describe("the owner's list in the store", () => {
  it("is kept per company, one row per family and version, and a damaged row is left out", async () => {
    const h = setup();
    h.docker.tags.set(PG15, digestOf("a"));
    await h.service.approve({ requested: "postgres:15" });
    const other = createOwnerImageStore({ store: h.documents, companyId: "org_bbbbbbbbbbbbbbbbbbbb" });
    expect(await other.list()).toEqual([]);
    await h.documents.put({ item: { pk: `ORG#${COMPANY.slice(4)}#TEST_SERVICE_IMAGES`, sk: "IMAGE#junk@1", entityType: "TEST_SERVICE_IMAGE", reference: "docker.io/library/postgres:15" } });
    expect(await h.store.list()).toHaveLength(1);
    expect(await h.service.remove(pg15("a"))).toBe(true);
    expect(await h.service.remove(pg15("a"))).toBe(false);
    expect(h.audited).toEqual(["test_services.image_approved", "test_services.image_removed"]);
  });

  it("is read late and survives a store that is not there yet: no approvals, starters still work", async () => {
    const docker = new OwnerDocker();
    const service = createOwnerImageService({ store: createOwnerImageStore({ store: () => { throw new Error("not registered yet"); }, companyId: COMPANY }), docker, now: () => 1 });
    const resolved = await resolveOwnerImages({ service, environment: ON, docker, now: () => 1 });
    expect(resolved.entries).toHaveLength(5);
  });
});

describe("signed or owner list is decided by the compiled-in key list, not by the keys that validate", () => {
  const unusable = [{ keyId: "0".repeat(64), publicKey: "not a key", algorithm: "ECDSA_SHA_256" as const }];
  it("a build with a key compiled in is a signed build even when no key validates, and then refuses: it never reads the owner's list", async () => {
    expect(catalogSigningKeysCompiledIn(unusable)).toBe(true);
    expect(catalogSigningKeysCompiledIn([])).toBe(false);
    expect(catalogSigningKeysCompiledIn()).toBe(false);
    const h = setup();
    const result = await prepareLocalTestServices({
      environment: { ...ON, ROVARA_TEST_SERVICES_REGISTRY: "registry.examplehost:5000" }, stateDirectory: mkdtempSync(join(tmpdir(), "rovara-owner-")), docker: h.docker, ownerImages: h.service, interfaces: {},
      signedKeysPresent: () => catalogSigningKeysCompiledIn(unusable),
    });
    expect(result).toMatchObject({ services: undefined, catalog: undefined, mode: "signed" });
    expect(result.ownerImages).toBeUndefined();
    expect(h.docker.calls).toEqual([]);
  });
});

describe("an approval on the page and an env pin never share a row", () => {
  it("keeps the page approval when the env list names the same family and version, and keeps it when the env entry goes away", async () => {
    const h = setup();
    h.docker.tags.set(PG15, digestOf("a"));
    h.docker.tags.set("docker.io/library/postgres:15.6", digestOf("env"));
    await h.service.approve({ requested: "postgres:15" });
    const env = { ...ON, ROVARA_TEST_SERVICE_IMAGES: "postgres:15.6" };
    const first = await install(h, env);
    expect(first.services!.images).toContain(pg15("a"));
    expect(first.services!.images).not.toContain(pg15("env"));
    expect((await h.service.list()).map((image) => [image.origin, image.reference])).toEqual([["page", pg15("a")]]);
    await install(h, ON);
    expect((await h.service.list()).map((image) => image.reference)).toEqual([pg15("a")]);
  });

  it("stores a page approval made after an env pin beside it, not over it, and removing the env pin leaves the approval", async () => {
    const h = setup();
    h.docker.tags.set("docker.io/library/postgres:15.6", digestOf("env"));
    h.docker.tags.set(PG15, digestOf("a"));
    await install(h, { ...ON, ROVARA_TEST_SERVICE_IMAGES: "postgres:15.6" });
    await h.service.approve({ requested: "postgres:15" });
    expect((await h.service.list()).map((image) => image.origin).sort()).toEqual(["env", "page"]);
    // The page's approval is listed first, so it wins the family and version; the env pin stays until it leaves the variable.
    const both = await install(h, { ...ON, ROVARA_TEST_SERVICE_IMAGES: "postgres:15.6" });
    expect(both.services!.images).toContain(pg15("a"));
    expect(both.services!.images).not.toContain(pg15("env"));
    await install(h, ON);
    expect((await h.service.list()).map((image) => [image.origin, image.reference])).toEqual([["page", pg15("a")]]);
  });
});

describe("removing an env pin never removes a page approval of the same digest", () => {
  it("leaves the page row when an env pin with the same reference leaves the variable", async () => {
    const h = setup();
    h.docker.tags.set("docker.io/library/postgres:15.6", digestOf("same"));
    h.docker.tags.set(PG15, digestOf("same"));
    await install(h, { ...ON, ROVARA_TEST_SERVICE_IMAGES: "postgres:15.6" });
    await h.service.approve({ requested: "postgres:15" });
    expect((await h.service.list()).map((image) => image.origin).sort()).toEqual(["env", "page"]);
    await install(h, ON);
    expect((await h.service.list()).map((image) => [image.origin, image.reference])).toEqual([["page", pg15("same")]]);
  });
});

describe("the refusal and schema wording", () => {
  it("names MongoDB among what can be approved, and says an owner-approved entry MUST be in a pinned catalog", () => {
    expect(OWNER_IMAGE_REFUSALS.unsupported_family).toContain("MongoDB");
    const entry = { ...JSON.parse(JSON.stringify(ownerCatalogOf(ownerStarterEntries())!.entries[0])) as object };
    const parsed = ServiceCatalogSchema.safeParse({ schemaVersion: 1, revision: 1, pinned: false, entries: [entry] });
    expect(JSON.stringify(parsed.success ? [] : parsed.error.issues.map((issue) => issue.message))).toContain("an owner-approved entry must be in a pinned catalog");
  });
});

describe("the signed catalog wins where a build has a key", () => {
  const owner = (): OwnerImageService => { throw new Error("the owner's list is not read when a catalog is signed"); };
  it("uses only the signed catalog and its registry, and never reads or pulls the owner's list", async () => {
    const h = setup();
    const state = mkdtempSync(join(tmpdir(), "rovara-owner-"));
    const catalog = verifiedCatalog(pinnedCatalog());
    const reads: string[] = [];
    const spy = new Proxy(h.service, { get: (target, key) => { reads.push(String(key)); return (target as never as Record<string | symbol, unknown>)[key]; } });
    const result = await prepareLocalTestServices({
      environment: { ...ON, ROVARA_TEST_SERVICES_REGISTRY: "registry.examplehost:5000", ROVARA_TEST_SERVICE_IMAGES: "postgres:15" }, stateDirectory: state, docker: h.docker, ownerImages: spy, interfaces: {},
      signedKeysPresent: () => true, loadCatalog: async () => ({ ok: true, catalog }),
    });
    expect(result.mode).toBe("signed");
    expect(result.catalog).toBe(catalog);
    expect(result.services!.ownerImages).toBeUndefined();
    expect(result.services!.registry).toBe("registry.examplehost:5000");
    expect(h.docker.pulls().length).toBeGreaterThan(0);
    expect(h.docker.pulls().every((name) => name.startsWith("registry.examplehost:5000/rovara-catalog/local/svc/"))).toBe(true);
    expect(h.docker.pulls().some((name) => name.includes("docker.io"))).toBe(false);
    expect(reads).toEqual([]);
    expect(result.ownerImages).toBeUndefined();
    void owner;
  });

  it("never falls back to the owner's list when the signed catalog does not verify or no registry is named", async () => {
    const h = setup();
    const failed = await prepareLocalTestServices({
      environment: { ...ON, ROVARA_TEST_SERVICES_REGISTRY: "registry.examplehost:5000" }, stateDirectory: "/nowhere", docker: h.docker, ownerImages: h.service, interfaces: {},
      signedKeysPresent: () => true, loadCatalog: async () => ({ ok: false, sentence: "no", reason: "the catalog is not signed by a key this release trusts" }),
    });
    expect(failed).toMatchObject({ services: undefined, catalog: undefined, mode: "signed" });
    expect(failed.ownerImages).toBeUndefined();
    const noRegistry = await prepareLocalTestServices({ environment: ON, stateDirectory: "/nowhere", docker: h.docker, ownerImages: h.service, interfaces: {}, signedKeysPresent: () => true });
    expect(noRegistry).toMatchObject({ services: undefined, mode: "signed" });
    expect(h.docker.calls).toEqual([]);
  });

  it("this build compiles in no catalog key, so Code uses the owner's list", async () => {
    const h = setup();
    expect((await install(h)).mode).toBe("owner");
  });
});

describe("what a change of the list does to the worker's machine", () => {
  it("changes the machine's digest part with the list, and leaves the signed path's part as it was", async () => {
    const h = setup();
    const one = (await install(h)).services!;
    h.docker.tags.set(PG15, digestOf("a"));
    await h.service.approve({ requested: "postgres:15" });
    const two = (await install(h)).services!;
    expect(JSON.stringify(localTestServicesDigestPart(one, undefined))).not.toBe(JSON.stringify(localTestServicesDigestPart(two, undefined)));
    const signedShape = { ...one, ownerImages: undefined };
    expect((localTestServicesDigestPart(signedShape, undefined) as unknown[]).length).toBe(5);
    expect(ownerImageReferences(two.ownerImages!).size).toBe(6);
  });
});
