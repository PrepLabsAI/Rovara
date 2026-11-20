// The GCP pack (lane L4-E8; spike L4-E8S; owner decision 2026-11-18): catalog entries for Pub/Sub, Firestore, Datastore, Bigtable, Spanner, Cloud Storage and BigQuery emulators, each marked MIRRORED or PULLED FROM SOURCE and pinned by digest;
// the setting that keeps all of it off by default; the environment that points Google's client libraries at the emulators (and tells them a made-up project, never a credential); the dependency detectors that find the clients; and the
// run profile of each emulator. Nothing here starts a container or reads a network.
import { describe, expect, it } from "vitest";
import {
  GCP_CREDENTIAL_VARIABLES, GCP_FAKE_PROJECT_ID, GCP_PACK, GCP_PACK_FAMILIES, GCP_PACK_SETTING_VARIABLE, IMPLICIT_COMPANY_ID, OWNER_GCP_PACK_IMAGES, OWNER_STARTER_IMAGES, OwnerListEntrySchema, ServiceCatalogSchema, CatalogEntrySchema,
  gcpPackGroupsOf, isGcpPackFamily, isPulledFromSourceReference, normalizeOwnerList, ownerCatalogOf, ownerGcpPackEntries, ownerGcpPackImagesFor, ownerGcpPackMirrorable, ownerImageReferences, ownerImageRequest, ownerStarterEntries,
  testServiceMirrorRepositories, mirroredStarterEntries, type CatalogEntry, type GcpPackFamily, type TestEnvDependencyCandidate,
} from "@agentx/contracts";
import { chooseBacking, effectiveAllowedBackings } from "../../packages/broker/src/core/test-env/backing-choice.js";
import { proposeDependencies } from "../../packages/broker/src/core/test-env/dependency-proposal.js";
import { hostedServiceCatalog } from "../../packages/broker/src/aws/hosted-test-services.js";
import { createOwnerImageService, createOwnerImageStore, resolveOwnerImages } from "../../packages/broker/src/local/test-services-owner-list.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { OwnerDocker } from "../support/owner-docker.js";
import { boundedReader, runDetectors } from "../../packages/worker/src/env-detect/index.js";
import { ServiceEnvError, buildServiceEnvironment, type ServiceEnvDependency } from "../../packages/worker/src/service-env.js";
import { startHelpers, type HelperFiles } from "../../packages/worker/src/service-helpers.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

// The digests the spike read on 2026-11-18 (briefs/lead4/L4-E8S-GCP-EMULATORS.md, "Full references"). Written out here on purpose: a changed pin must fail a test, not pass it.
const SDK_DIGEST = "4568487af2c00a66e1d3e0f054be208c9c5b499a3999da50428b396e1341e9fd";
const PINS: Record<string, string> = {
  pubsub: `gcr.io/google.com/cloudsdktool/google-cloud-cli@sha256:${SDK_DIGEST}`,
  firestore: `gcr.io/google.com/cloudsdktool/google-cloud-cli@sha256:${SDK_DIGEST}`,
  datastore: `gcr.io/google.com/cloudsdktool/google-cloud-cli@sha256:${SDK_DIGEST}`,
  bigtable: `gcr.io/google.com/cloudsdktool/google-cloud-cli@sha256:${SDK_DIGEST}`,
  spanner: "gcr.io/cloud-spanner-emulator/emulator@sha256:5f71fecd6330211789b75065ade9587d67b3a6b4678e7e5408e42c22f778c63e",
  gcs: "docker.io/fsouza/fake-gcs-server@sha256:797ce226d62f947c009dc40246b30cfb456b8473d8241407f9d6f2c04e4d69ef",
  bigquery: "ghcr.io/goccy/bigquery-emulator@sha256:f4e428d265a93dc5ce36c294e1c584c7c9b384117d47ab8ddbb63d8d50b7f393",
};
const ENV_NAMES: Record<string, string[]> = {
  pubsub: ["PUBSUB_EMULATOR_HOST"], firestore: ["FIRESTORE_EMULATOR_HOST"], datastore: ["DATASTORE_EMULATOR_HOST"], bigtable: ["BIGTABLE_EMULATOR_HOST"], spanner: ["SPANNER_EMULATOR_HOST"],
  gcs: ["STORAGE_EMULATOR_HOST"], bigquery: ["BIGQUERY_EMULATOR_HOST", "BIGQUERY_API_ENDPOINT"],
};
const ALL_ON = { [GCP_PACK_SETTING_VARIABLE]: "mirrored,pulled,bigquery" };
const packCatalog = () => ownerCatalogOf([...ownerStarterEntries(), ...ownerGcpPackEntries(ownerGcpPackImagesFor(ALL_ON))])!;
const packEntry = (family: string): CatalogEntry => packCatalog().entries.find((entry) => entry.family === family)!;

describe("the pack's images: pinned by digest, marked mirrored or pulled from source", () => {
  it("lists exactly the seven services, each pinned to the spike's index digest", () => {
    expect(OWNER_GCP_PACK_IMAGES.map((image) => image.family)).toEqual(["pubsub", "firestore", "datastore", "bigtable", "spanner", "gcs", "bigquery"]);
    expect([...GCP_PACK_FAMILIES]).toEqual(OWNER_GCP_PACK_IMAGES.map((image) => image.family));
    for (const image of OWNER_GCP_PACK_IMAGES) {
      expect(image.reference, image.family).toBe(PINS[image.family]);
      expect(OwnerListEntrySchema.safeParse({ reference: image.reference, family: image.family, version: image.version }).success, image.family).toBe(true);
      expect(image.source).toMatch(/read with crane .* on 2026-11-18; lists linux\/arm64 and linux\/amd64/u);
    }
  });

  it("marks Google's SDK image (Pub/Sub, Firestore, Datastore, Bigtable) as pulled from source, and Spanner, Cloud Storage and BigQuery as mirrored", () => {
    const marks = Object.fromEntries(OWNER_GCP_PACK_IMAGES.map((image) => [image.family, image.distribution]));
    expect(marks).toEqual({ pubsub: "pulled_from_source", firestore: "pulled_from_source", datastore: "pulled_from_source", bigtable: "pulled_from_source", spanner: "mirrored", gcs: "mirrored", bigquery: "mirrored" });
    expect(OWNER_GCP_PACK_IMAGES.find((image) => image.family === "bigquery")!.gate).toBe("r8_dry_run");
    expect(OWNER_GCP_PACK_IMAGES.filter((image) => image.gate !== undefined)).toHaveLength(1);
    for (const image of OWNER_GCP_PACK_IMAGES) expect(GCP_PACK[image.family].distribution, image.family).toBe(image.distribution);
    // The table's licence readings: only the SDK image is not an open licence.
    expect(Object.fromEntries(GCP_PACK_FAMILIES.map((family) => [family, GCP_PACK[family].licence]))).toEqual({
      pubsub: "LicenseRef-Google-owned", firestore: "LicenseRef-Google-owned", datastore: "LicenseRef-Google-owned", bigtable: "LicenseRef-Google-owned", spanner: "Apache-2.0", gcs: "BSD-2-Clause", bigquery: "MIT",
    });
  });

  it("never lets the Google SDK image into the registry mirror: the mirrorable list and the mirror's repositories hold none of it", () => {
    expect(ownerGcpPackMirrorable().map((image) => image.family)).toEqual(["spanner", "gcs", "bigquery"]);
    expect(isPulledFromSourceReference(PINS["pubsub"]!)).toBe(true);
    expect(isPulledFromSourceReference(PINS["spanner"]!)).toBe(false);
    for (const image of ownerGcpPackMirrorable()) expect(isPulledFromSourceReference(image.reference)).toBe(false);
    // The install's mirror is made from the five starter images and nothing of the pack, so the pack changes no repository, no pull and no boot stage.
    const mirror = testServiceMirrorRepositories("staging");
    expect(mirror).toHaveLength(5);
    expect(mirror.some((repository) => repository.digest === SDK_DIGEST || /google|cloudsdk/u.test(repository.repositoryName))).toBe(false);
    expect(mirroredStarterEntries("123456789012.dkr.ecr.us-west-2.amazonaws.com", "staging").map((entry) => entry.family).sort()).toEqual(["mongodb", "mysql", "postgres", "postgres", "redis"]);
    expect(OWNER_STARTER_IMAGES).toHaveLength(5);
  });

  it("takes an entry only from the repository the pack gives its family, pinned by digest and nothing else", () => {
    const good = { reference: PINS["gcs"]!, family: "gcs", version: "1.56.1" };
    expect(OwnerListEntrySchema.safeParse(good).success).toBe(true);
    // another image under a pack family's name, a pack image under another family, the SDK image for a database family
    expect(OwnerListEntrySchema.safeParse({ ...good, reference: `docker.io/evil/fake-gcs-server@sha256:${"a".repeat(64)}` }).success).toBe(false);
    expect(OwnerListEntrySchema.safeParse({ ...good, family: "spanner" }).success).toBe(false);
    expect(OwnerListEntrySchema.safeParse({ reference: PINS["pubsub"]!, family: "postgres", version: "594.0.0" }).success).toBe(false);
    expect(OwnerListEntrySchema.safeParse({ reference: `docker.io/library/postgres@sha256:${"a".repeat(64)}`, family: "pubsub", version: "16" }).success).toBe(false);
    // a tag, a short digest or a registry spelled another way is not a pin
    expect(OwnerListEntrySchema.safeParse({ ...good, reference: "docker.io/fsouza/fake-gcs-server:1.56.1" }).success).toBe(false);
    expect(OwnerListEntrySchema.safeParse({ ...good, reference: `docker.io/fsouza/fake-gcs-server@sha256:${"a".repeat(63)}` }).success).toBe(false);
    expect(OwnerListEntrySchema.safeParse({ ...good, family: "unknown" }).success).toBe(false);
  });

  it("is not reachable through an owner's own approval: a tag of a pack image is refused as an unsupported family", () => {
    for (const requested of ["fsouza/fake-gcs-server:1.56.1", "gcr.io/cloud-spanner-emulator/emulator:1.5.59", "gcr.io/google.com/cloudsdktool/google-cloud-cli:594.0.0-emulators", "ghcr.io/goccy/bigquery-emulator:0.8.1"]) {
      expect(ownerImageRequest(requested), requested).toEqual({ ok: false, reason: "unsupported_family" });
    }
  });
});

describe("the pack is off unless the setting names a group", () => {
  it("reads the setting as a comma list of groups, failing closed", () => {
    expect([...gcpPackGroupsOf(undefined)]).toEqual([]);
    expect([...gcpPackGroupsOf("")]).toEqual([]);
    expect([...gcpPackGroupsOf("1")]).toEqual([]);
    expect([...gcpPackGroupsOf("true")]).toEqual([]);
    expect([...gcpPackGroupsOf("all")]).toEqual([]);
    expect([...gcpPackGroupsOf(" Mirrored , pulled,bogus")].sort()).toEqual(["mirrored", "pulled"]);
  });
  it("switches on only the images of the groups it names", () => {
    const families = (value: string | undefined) => ownerGcpPackImagesFor(value === undefined ? {} : { [GCP_PACK_SETTING_VARIABLE]: value }).map((image) => image.family);
    expect(families(undefined)).toEqual([]);
    expect(families("mirrored")).toEqual(["spanner", "gcs"]);
    expect(families("pulled")).toEqual(["pubsub", "firestore", "datastore", "bigtable"]);
    expect(families("bigquery")).toEqual(["bigquery"]);
    expect(families("mirrored,pulled,bigquery")).toEqual([...GCP_PACK_FAMILIES]);
  });
  it("changes nothing on the hosted catalog and the starter list while the pack is off", async () => {
    const hosted = await hostedServiceCatalog({ ROVARA_TEST_SERVICES: "1" })!();
    expect(hosted!.entries.map((entry) => entry.id).sort()).toEqual(["mongodb@7", "mysql@8", "postgres@16", "postgres@17", "redis@7"]);
    expect(ownerStarterEntries().map((entry) => entry.family).sort()).toEqual(["mongodb", "mysql", "postgres", "postgres", "redis"]);
  });
});

describe("the catalog entries", () => {
  it("builds one valid catalog entry per service, pinned by digest, owner-approved, non-root, with its own licence and port", () => {
    const catalog = packCatalog();
    ServiceCatalogSchema.parse(JSON.parse(JSON.stringify(catalog)));
    const ids = catalog.entries.map((entry) => entry.id).sort();
    expect(ids).toEqual(["bigquery@0", "bigtable@594", "datastore@594", "firestore@594", "gcs@1", "mongodb@7", "mysql@8", "postgres@16", "postgres@17", "pubsub@594", "redis@7", "spanner@1"]);
    for (const family of GCP_PACK_FAMILIES) {
      const entry = packEntry(family);
      expect(entry, family).toBeDefined();
      expect(entry.ownerApproved).toBe(true);
      expect(entry.backing).toBe("local");
      expect(entry.status).toBe("default");
      expect(entry.image.digest).toBe(PINS[family]!.slice(-64));
      expect(entry.image.repository).toBe(`svc/${family}`);
      expect(entry.licence).toBe(GCP_PACK[family].licence);
      expect(entry.run.ports).toEqual([...GCP_PACK[family].ports]);
      expect(entry.run.user).toBe("65532:65532");
      expect(entry.run.readOnlyRoot).toBe(true);
      expect(entry.reset.kind).toBe("restart");
      expect(entry.health).toMatchObject({ kind: "tcp", port: GCP_PACK[family].ports[0] });
      expect(entry.connect.defaultAliases).toEqual([GCP_PACK[family].alias]);
      expect(CatalogEntrySchema.safeParse(entry).success, family).toBe(true);
    }
  });

  it("names the images by the pack's source reference, and keeps one entry per family when two share an image", () => {
    const references = ownerImageReferences([...ownerStarterEntries(), ...ownerGcpPackEntries(OWNER_GCP_PACK_IMAGES)]);
    for (const family of GCP_PACK_FAMILIES) expect(references.get(`svc/${family}@sha256:${PINS[family]!.slice(-64)}`), family).toBe(PINS[family]);
    // the four SDK families share one image but are four entries
    expect(normalizeOwnerList(ownerGcpPackEntries(OWNER_GCP_PACK_IMAGES))).toHaveLength(7);
  });

  it("keeps each start command a fixed argument id valid only for its own family", () => {
    expect(packEntry("pubsub").run.extraArgs).toEqual(["gcp_pubsub_start"]);
    expect(packEntry("firestore").run.extraArgs).toEqual(["gcp_firestore_start"]);
    expect(packEntry("datastore").run.extraArgs).toEqual(["gcp_datastore_start"]);
    expect(packEntry("bigtable").run.extraArgs).toEqual(["gcp_bigtable_start"]);
    expect(packEntry("spanner").run.extraArgs).toEqual([]);
    expect(packEntry("gcs").run.extraArgs).toEqual(["gcs_http_memory"]);
    expect(packEntry("bigquery").run.extraArgs).toEqual(["bigquery_fake_project"]);
    expect(CatalogEntrySchema.safeParse({ ...packEntry("firestore"), run: { ...packEntry("firestore").run, extraArgs: ["gcp_pubsub_start"] } }).success).toBe(false);
    expect(CatalogEntrySchema.safeParse({ ...packEntry("gcs"), run: { ...packEntry("gcs").run, extraArgs: ["redis_save_off"] } }).success).toBe(false);
  });

  it("puts the emulator variable each Google client reads in the entry's own connection templates", () => {
    for (const family of GCP_PACK_FAMILIES) expect(Object.keys(packEntry(family).connect.templates).sort(), family).toEqual([...ENV_NAMES[family]!].sort());
    expect(packEntry("gcs").connect.templates).toEqual({ STORAGE_EMULATOR_HOST: "{endpoint}" });
    expect(packEntry("pubsub").connect.templates).toEqual({ PUBSUB_EMULATOR_HOST: "{host}:{port}" });
    expect(isGcpPackFamily("spanner")).toBe(true);
    expect(isGcpPackFamily("postgres")).toBe(false);
  });
});

describe("the environment that points the clients at the emulators", () => {
  const depOf = (family: GcpPackFamily): ServiceEnvDependency => {
    const entry = packEntry(family);
    return { id: family, host: entry.connect.defaultAliases[0]!, port: entry.run.ports[0]!, credentials: {}, connect: { env: Object.entries(entry.connect.templates).map(([name, template]) => ({ name, template })), hostAliases: [...entry.connect.defaultAliases] } };
  };
  const build = (families: GcpPackFamily[], gcp?: { projectId?: string }) => Object.fromEntries(buildServiceEnvironment({ sandbox: "working", sinkholeUrl: "http://sinkhole", dependencies: families.map(depOf), ...(gcp === undefined ? {} : { gcp }) }).entries);

  it("adds a made-up project id and no credential when the run has a pack dependency, and no Google variable when it has none", () => {
    const env = build(["pubsub", "gcs"], {});
    expect(env).toMatchObject({ GOOGLE_CLOUD_PROJECT: GCP_FAKE_PROJECT_ID, GCLOUD_PROJECT: GCP_FAKE_PROJECT_ID, CLOUDSDK_CORE_PROJECT: GCP_FAKE_PROJECT_ID });
    for (const name of GCP_CREDENTIAL_VARIABLES) expect(Object.hasOwn(env, name), name).toBe(false);
    expect(Object.values(env).some((value) => /key|token|secret|-----/iu.test(value))).toBe(false);
    expect(Object.keys(build(["pubsub"])).some((name) => name.startsWith("GOOGLE_") || name.startsWith("CLOUDSDK_") || name === "GCLOUD_PROJECT")).toBe(false);
    expect(build([], undefined)).toEqual({});
  });

  it("refuses a project id that is not the shape of one, and any dependency that names a Google credential variable", () => {
    expect(() => build(["pubsub"], { projectId: "Bad Project" })).toThrow(ServiceEnvError);
    expect(() => build(["pubsub"], { projectId: "x\nAWS_X=1" })).toThrow(ServiceEnvError);
    expect(build(["pubsub"], { projectId: "my-fake-project-1" })["GOOGLE_CLOUD_PROJECT"]).toBe("my-fake-project-1");
    for (const name of GCP_CREDENTIAL_VARIABLES) {
      const dependency: ServiceEnvDependency = { ...depOf("pubsub"), connect: { env: [{ name, template: "{host}" }], hostAliases: ["pubsub"] } };
      expect(() => buildServiceEnvironment({ sandbox: "working", sinkholeUrl: "http://sinkhole", dependencies: [dependency] }), name).toThrow(ServiceEnvError);
    }
    // a dependency may not set the project variable either: the run's block owns it
    const clash: ServiceEnvDependency = { ...depOf("pubsub"), connect: { env: [{ name: "GOOGLE_CLOUD_PROJECT", template: "{host}" }], hostAliases: ["pubsub"] } };
    expect(() => buildServiceEnvironment({ sandbox: "working", sinkholeUrl: "http://sinkhole", dependencies: [clash], gcp: {} })).toThrow(ServiceEnvError);
  });
});

describe("the detectors find the Google Cloud clients", () => {
  async function detect(files: Record<string, string>) {
    const bounded = boundedReader(Object.keys(files), (path) => Promise.resolve(files[path]));
    return runDetectors(bounded.reader, "svc");
  }
  const families = (detection: Awaited<ReturnType<typeof detect>>) => (detection.dependencies ?? []).map((item) => item.family).sort();
  const find = (detection: Awaited<ReturnType<typeof detect>>, id: string) => detection.dependencies?.find((item) => item.family === id);

  it("finds each google-cloud-* package in a Python requirements file and pyproject, with its kind", async () => {
    const detection = await detect({
      "requirements.txt": "google-cloud-pubsub==2.23\ngoogle_cloud_firestore>=2\ngoogle-cloud-datastore\ngoogle-cloud-bigtable\ngoogle-cloud-spanner\ngoogle-cloud-storage\ngoogle-cloud-bigquery[pandas]\ngoogle-cloud-vision\ngoogle-cloud-secret-manager\nrequests\n",
    });
    expect(families(detection)).toEqual(["bigquery", "bigtable", "datastore", "firestore", "gcs", "pubsub", "spanner"]);
    expect(find(detection, "pubsub")).toMatchObject({ kind: "queue", strength: "mentioned", evidence: [{ path: "requirements.txt", line: 1 }] });
    expect(find(detection, "gcs")).toMatchObject({ kind: "object_store" });
    expect(find(detection, "spanner")).toMatchObject({ kind: "database" });
    const toml = await detect({ "pyproject.toml": ["[project]", "dependencies = [", '  "google-cloud-pubsub>=2",', '  "google-cloud-storage",', "]", ""].join("\n") });
    expect(families(toml)).toEqual(["gcs", "pubsub"]);
  });

  it("finds the Python imports in every form, and flags a client built with a literal endpoint", async () => {
    const code = [
      "from google.cloud import pubsub_v1, storage",
      "import google.cloud.firestore",
      "from google.cloud.datastore import Client",
      "from google.cloud import (bigtable,",
      "    spanner)",
      "from google.cloud import bigquery as bq",
      "import os",
      'publisher = pubsub_v1.PublisherClient(client_options={"api_endpoint": "localhost:8085"})',
      "client = storage.Client(project=os.environ['P'])",
      "",
    ].join("\n");
    const detection = await detect({ "svc/app.py": code });
    // a parenthesised import that wraps onto the next line is read too
    expect(families(detection)).toEqual(["bigquery", "bigtable", "datastore", "firestore", "gcs", "pubsub", "spanner"]);
    expect(find(detection, "pubsub")).toMatchObject({ strength: "used", evidence: [{ path: "svc/app.py", line: 1 }], hints: { explicitEndpoint: true } });
    expect(find(detection, "gcs")!.hints.explicitEndpoint).toBeUndefined();
    // a name that is not a pack module is left alone
    const other = await detect({ "a.py": "from google.cloud import vision, storage_transfer, secretmanager\nimport google.cloud.storage_transfer_v1\n" });
    expect(other.dependencies).toBeUndefined();
  });

  it("finds @google-cloud/* packages in package.json and their imports in code", async () => {
    const detection = await detect({
      "package.json": JSON.stringify({ dependencies: { "@google-cloud/pubsub": "4", "@google-cloud/storage": "7", express: "4" }, devDependencies: { "@google-cloud/firestore": "7", "@google-cloud/bigquery": "7", "@google-cloud/vision": "4" } }, null, 2),
      "src/a.ts": 'import { Spanner } from "@google-cloud/spanner";\nconst { Bigtable } = require("@google-cloud/bigtable");\nconst d = require("@google-cloud/datastore");\nconst s = new Spanner({ projectId: "x", apiEndpoint: "localhost:9010" });\n',
    });
    expect(families(detection)).toEqual(["bigquery", "bigtable", "datastore", "firestore", "gcs", "pubsub", "spanner"]);
    expect(find(detection, "pubsub")).toMatchObject({ strength: "mentioned", evidence: [{ path: "package.json", line: 3 }] });
    expect(find(detection, "spanner")).toMatchObject({ strength: "used", evidence: [{ path: "src/a.ts", line: 1 }], hints: { explicitEndpoint: true } });
    expect(find(detection, "bigtable")!.hints.explicitEndpoint).toBeUndefined();
  });

  it("finds the Go and Java clients, and the community emulator images in a compose file", async () => {
    const detection = await detect({
      "go.mod": "module x\n\nrequire (\n\tcloud.google.com/go/pubsub v1.37.0\n\tcloud.google.com/go/storage v1.40.0\n\tcloud.google.com/go/vision v1.0.0\n)\n",
      "main.go": 'package main\nimport "cloud.google.com/go/spanner"\n',
      "pom.xml": "<project><dependencies><dependency><groupId>com.google.cloud</groupId><artifactId>google-cloud-firestore</artifactId></dependency><dependency><groupId>com.google.cloud</groupId><artifactId>google-cloud-vision</artifactId></dependency></dependencies></project>",
      "src/A.java": "import com.google.cloud.bigtable.data.v2.BigtableDataClient;\n",
      "docker-compose.yml": "services:\n  gcs:\n    image: fsouza/fake-gcs-server:1.56\n  bq:\n    image: ghcr.io/goccy/bigquery-emulator:latest\n",
    });
    expect(families(detection)).toEqual(["bigquery", "bigtable", "firestore", "gcs", "pubsub", "spanner"]);
    expect(find(detection, "gcs")!.strength).toBe("declared");
  });
});

describe("a service the catalog does not have falls back as any other missing service does", () => {
  const candidate = (family: GcpPackFamily, version?: string): TestEnvDependencyCandidate => ({ family, kind: GCP_PACK[family].kind, evidence: [{ path: "requirements.txt", line: 1 }], strength: "mentioned", hints: version === undefined ? {} : { version } });
  const context = (catalog: ReturnType<typeof ownerCatalogOf>) => ({ catalog, edition: "public" as const, projectId: "service", prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] } });

  it("with the pack off, a pack dependency is not proposed as real software (one fixed note), exactly like a family with no entry", () => {
    const starterOnly = ownerCatalogOf(ownerStarterEntries());
    const proposal = proposeDependencies([candidate("pubsub"), candidate("gcs")], context(starterOnly));
    expect(proposal.dependencies).toEqual([]);
    expect(proposal.notes).toHaveLength(1);
    const rabbit = proposeDependencies([{ ...candidate("pubsub"), family: "rabbitmq", kind: "queue" }], context(starterOnly));
    expect(rabbit).toEqual(proposal);
  });

  it("the chooser then leaves the never-stop answer to what the kind allows: a fake (made-up answers) for object storage, nothing for a queue or a database", () => {
    const starterOnly = ownerCatalogOf(ownerStarterEntries())!;
    const choose = (family: GcpPackFamily, canMakeFake: boolean) => chooseBacking({
      dependency: { family, kind: GCP_PACK[family].kind }, place: "task_check", edition: "public", allowed: effectiveAllowedBackings(undefined), catalog: starterOnly, projectId: "service",
      projectImages: [], accounts: [], prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, fixtures: [], canMakeFake, now: 0,
    });
    expect(choose("gcs", true).backing).toEqual({ kind: "fake", fixtureSetRef: undefined, origin: "to_make" });
    expect(choose("gcs", true).skipped.find((step) => step.step === "local")!.reason).toBe("not_in_catalog");
    expect(choose("pubsub", true).backing.kind).toBe("none");
    expect(choose("spanner", true).skipped.find((step) => step.step === "fake")!.reason).toBe("fake_not_for_this_kind");
  });

  it("with the pack on, each service is proposed as real software with its emulator variable and alias, and the version of its entry is not needed", () => {
    const proposal = proposeDependencies(GCP_PACK_FAMILIES.map((family) => candidate(family)), context(packCatalog()));
    expect(proposal.notes).toEqual([]);
    expect(proposal.dependencies.map((dependency) => dependency.family)).toEqual([...GCP_PACK_FAMILIES]);
    for (const dependency of proposal.dependencies) {
      const family = dependency.family as GcpPackFamily;
      expect(dependency.backing).toMatchObject({ kind: "local", catalogId: packEntry(family).id });
      expect(dependency.name).toBe(GCP_PACK[family].name);
      expect(dependency.kind).toBe(GCP_PACK[family].kind);
      expect(dependency.connect.hostAliases).toEqual([GCP_PACK[family].alias]);
      expect(dependency.connect.env.map((item) => item.name).sort()).toEqual([...ENV_NAMES[family]!].sort());
    }
  });
});

describe("the laptop's list of images in effect", () => {
  function setup() {
    const docker = new OwnerDocker();
    const store = createOwnerImageStore({ store: new MemoryDocumentStore({ indexes: [] }), companyId: IMPLICIT_COMPANY_ID });
    const service = createOwnerImageService({ store, docker, now: () => 1_800_000_000_000, companyId: IMPLICIT_COMPANY_ID });
    return { docker, service };
  }
  const resolve = async (environment: NodeJS.ProcessEnv) => {
    const h = setup();
    const resolved = await resolveOwnerImages({ service: h.service, environment, docker: h.docker, now: () => 0, pull: "on-first-use" });
    return { ...resolved, docker: h.docker };
  };

  it("holds only the starter images by default, and adds the pack's groups when the setting names them", async () => {
    expect((await resolve({})).entries.map((entry) => entry.family).sort()).toEqual(["mongodb", "mysql", "postgres", "postgres", "redis"]);
    expect((await resolve({ [GCP_PACK_SETTING_VARIABLE]: "bogus" })).entries.map((entry) => entry.family).sort()).toEqual(["mongodb", "mysql", "postgres", "postgres", "redis"]);
    const mirrored = await resolve({ [GCP_PACK_SETTING_VARIABLE]: "mirrored" });
    expect(mirrored.entries.map((entry) => entry.family).sort()).toEqual(["gcs", "mongodb", "mysql", "postgres", "postgres", "redis", "spanner"]);
    const all = await resolve({ [GCP_PACK_SETTING_VARIABLE]: "mirrored,pulled,bigquery" });
    expect(all.entries.filter((entry) => isGcpPackFamily(entry.family)).map((entry) => entry.reference).sort()).toEqual(OWNER_GCP_PACK_IMAGES.map((image) => image.reference).sort());
    // nothing is pulled at `rovara up`: the images come by digest the first time a step needs one
    expect(all.docker.pulls()).toEqual([]);
  });
});

describe("the run profile of each emulator", () => {
  const files = (): { spy: HelperFiles; written: Array<[string, string]> } => {
    const written: Array<[string, string]> = [];
    return { written, spy: { write: async (name, content) => { written.push([name, content]); return `/run/files/${name}`; }, remove: async () => undefined } };
  };
  const net = {
    name: "rovara-svc-0123456789ab", bridge: "rvi01234567", slot: 7, subnet: "172.30.7.0/24", gateway: "172.30.7.1", ipRange: "172.30.7.128/25", dnsHelperIp: "172.30.7.2", workingSandboxIp: "172.30.7.3", checkSandboxIp: "172.30.7.4", proxyIp: "172.30.7.5",
    helperIp: (index: number) => `172.30.7.${String(16 + index)}`, labelArgs: () => ["--label", "x=1"], stop: async () => undefined,
  };
  async function start(family: GcpPackFamily) {
    const args: string[][] = [];
    const cli = { run: async (call: string[]) => { args.push(call); return { exitCode: 0, stdout: call[0] === "image" ? "null\n" : call[0] === "inspect" ? "running\n" : "", stderr: "" }; } } as unknown as DockerCli;
    const entry = packEntry(family);
    const { spy, written } = files();
    await startHelpers(cli, net, {
      registry: "owner-list.invalid", edition: "public", probeImage: `sha256:${"a".repeat(64)}`, maxMemMiB: 3072, files: spy, imageReferences: ownerImageReferences(ownerGcpPackEntries(OWNER_GCP_PACK_IMAGES)),
      helpers: [{ id: family, name: family, entry, aliases: [entry.connect.defaultAliases[0]!], credentials: { user: "rovara", password: "p".repeat(32), database: "app" } }], now: () => 0, sleep: async () => undefined,
    });
    return { run: args.find((call) => call[0] === "run" && call.includes("--detach"))!, written };
  }

  it.each(GCP_PACK_FAMILIES)("%s starts from its pinned source reference, non-root, read-only, with every capability dropped", async (family) => {
    const { run } = await start(family);
    expect(run).toContain(PINS[family]);
    expect(run).toEqual(expect.arrayContaining(["--user", "65532:65532", "--cap-drop", "ALL", "--read-only", "--pull=never", "--security-opt", "no-new-privileges"]));
    expect(run.some((part) => part.includes("owner-list.invalid"))).toBe(false);
    expect(run).toEqual(expect.arrayContaining(["--network-alias", GCP_PACK[family].alias]));
  });

  it("runs gcloud as the command of Google's SDK image, with gcloud's settings on the tmpfs and no usage report", async () => {
    const pubsub = await start("pubsub");
    expect(pubsub.run.slice(pubsub.run.indexOf(PINS["pubsub"]!) + 1)).toEqual(["gcloud", "beta", "emulators", "pubsub", "start", "--quiet", "--host-port=0.0.0.0:8085"]);
    expect(pubsub.written).toHaveLength(1);
    expect(pubsub.written[0]![1]).toBe("HOME=/tmp\nCLOUDSDK_CONFIG=/tmp/gcloud\nCLOUDSDK_CORE_DISABLE_USAGE_REPORTING=true\nCLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK=true\nCLOUDSDK_CORE_DISABLE_PROMPTS=1\n");
    const datastore = await start("datastore");
    expect(datastore.run.slice(datastore.run.indexOf(PINS["datastore"]!) + 1)).toEqual(["gcloud", "emulators", "firestore", "start", "--quiet", "--database-mode=datastore-mode", "--host-port=0.0.0.0:8080"]);
    const firestore = await start("firestore");
    expect(firestore.run.slice(firestore.run.indexOf(PINS["firestore"]!) + 1)).not.toContain("--database-mode=datastore-mode");
    const bigtable = await start("bigtable");
    expect(bigtable.run.slice(bigtable.run.indexOf(PINS["bigtable"]!) + 1)).toContain("--host-port=0.0.0.0:8086");
  });

  it("keeps the image's own entrypoint for Spanner, and passes flags only to Cloud Storage and BigQuery", async () => {
    const spanner = await start("spanner");
    expect(spanner.run.at(-1)).toBe(PINS["spanner"]);
    expect(spanner.written).toEqual([]);
    const gcs = await start("gcs");
    expect(gcs.run.slice(gcs.run.indexOf(PINS["gcs"]!) + 1)).toEqual(["-scheme", "http", "-backend", "memory", "-port", "4443"]);
    const bigquery = await start("bigquery");
    expect(bigquery.run.slice(bigquery.run.indexOf(PINS["bigquery"]!) + 1)).toEqual([`--project=${GCP_FAKE_PROJECT_ID}`]);
  });

  it("refuses to start a pack image from a reference that is not on the list, or from the same repository with another digest", async () => {
    const entry = packEntry("spanner");
    const cli = { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) } as unknown as DockerCli;
    const base = { registry: "owner-list.invalid", edition: "public" as const, probeImage: `sha256:${"a".repeat(64)}`, maxMemMiB: 3072, files: files().spy, now: () => 0, sleep: async () => undefined, helpers: [{ id: "spanner", name: "spanner", entry, aliases: ["spanner"], credentials: { user: "rovara", password: "p".repeat(32), database: "app" } }] };
    await expect(startHelpers(cli, net, { ...base, imageReferences: ownerImageReferences(ownerStarterEntries()) })).rejects.toThrow(/cannot be started here/u);
  });
});
