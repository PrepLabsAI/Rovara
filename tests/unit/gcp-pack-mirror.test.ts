// L4-E8I (owner DEC 254zzz62): the pure parts of the GCP pack's infrastructure lane: the names of the three image copies, what a hosted worker's owner list says for the pack, the worker image's CLI answers the boot stage reads,
// the hosted catalog with the setting on, the boot configuration that carries the setting to a worker, and the `agentx config` key. Nothing here reads a file, the environment or a network.
import { describe, expect, it } from "vitest";
import {
  GCP_PACK_PARAMETER_VALUES, GCP_PACK_SETTING_VARIABLE, OWNER_GCP_PACK_IMAGES, OwnerListEntrySchema, ownerCatalogOf, ownerStarterEntries, gcpPackMirrorMatches, gcpPackMirrorRepositories, gcpPackMirrorRepositoryName,
  gcpPackWorkerEntries, mirroredStarterEntries, testServiceMirrorRepositories,
} from "@agentx/contracts";
import { hostedGcpPackSetting, hostedServiceCatalog, hostedWorkersRunTestServices } from "../../packages/broker/src/aws/hosted-test-services.js";
import { ec2WorkerBootScript, type Ec2WorkerBootConfig } from "../../packages/contracts/src/session.js";
import { CONFIG_KEYS, configKey } from "../../packages/cli/src/config/keys.js";
import { OPERATOR_PARAMETERS } from "../../packages/cli/src/deploy/parameters.js";
import { mirrorPlan } from "../../scripts/test-services-mirror.js";
import { testServicesMirrorOutput } from "../../packages/worker/src/test-services-mirror-cli.js";

const REGISTRY = "111122223333.dkr.ecr.us-west-2.amazonaws.com";
const d = (c: string) => c.repeat(64);
const SPANNER_COPY = `${REGISTRY}/agentx-staging--test-services/spanner-1.5.59/spanner@sha256:${d("a")}`;

describe("the pack's copies in the install's ECR", () => {
  it("are named from the pack list: one repository per mirrorable image, the family's id as the last part, the same names in every place that reads them", () => {
    expect(gcpPackMirrorRepositoryName("staging", "spanner", "1.5.59")).toBe("agentx-staging--test-services/spanner-1.5.59/spanner");
    const repositories = gcpPackMirrorRepositories("staging");
    expect(repositories.map((repository) => [repository.image.family, repository.repositoryName, repository.tag])).toEqual([
      ["spanner", "agentx-staging--test-services/spanner-1.5.59/spanner", "1.5.59-5f71fecd6330"],
      ["gcs", "agentx-staging--test-services/gcs-1.56.1/gcs", "1.56.1-797ce226d62f"],
      ["bigquery", "agentx-staging--test-services/bigquery-0.8.1/bigquery", "0.8.1-f4e428d265a9"],
    ]);
    // The five starters' repositories are exactly what they were, and none of the pack's is among them.
    expect(testServiceMirrorRepositories("staging")).toHaveLength(5);
    for (const repository of repositories) expect(testServiceMirrorRepositories("staging").map((starter) => starter.repositoryName)).not.toContain(repository.repositoryName);
    expect(() => gcpPackMirrorRepositoryName("Staging", "spanner", "1.5.59")).toThrow();
    expect(() => gcpPackMirrorRepositories("")).toThrow();
  });

  it("the pulled images are never in the mirror: the SDK image's families have no repository", () => {
    for (const repository of gcpPackMirrorRepositories("staging")) expect(["pubsub", "firestore", "datastore", "bigtable"]).not.toContain(repository.image.family);
    expect(gcpPackMirrorRepositories("staging").every((repository) => repository.image.distribution === "mirrored")).toBe(true);
  });
});

describe("the owner list's schema and the install's copies", () => {
  const entry = (reference: string, family: string, version: string) => OwnerListEntrySchema.safeParse({ reference, family, version }).success;

  it("accepts a mirrored family's own ECR copy, and only that: the right account form, environment form, family and version", () => {
    expect(entry(SPANNER_COPY, "spanner", "1.5.59")).toBe(true);
    expect(gcpPackMirrorMatches("spanner", "1.5.59", REGISTRY, "agentx-staging--test-services/spanner-1.5.59/spanner")).toBe(true);
    for (const [name, reference, family, version] of [
      ["another version", SPANNER_COPY, "spanner", "1.5.58"],
      ["another family's directory", `${REGISTRY}/agentx-staging--test-services/gcs-1.56.1/gcs@sha256:${d("a")}`, "spanner", "1.5.59"],
      ["the image's own name, not the family's", `${REGISTRY}/agentx-staging--test-services/spanner-1.5.59/emulator@sha256:${d("a")}`, "spanner", "1.5.59"],
      ["a repository outside the family of names", `${REGISTRY}/agentx-staging/spanner-1.5.59/spanner@sha256:${d("a")}`, "spanner", "1.5.59"],
      ["the pull-through prefix", `${REGISTRY}/agentx-staging/worker@sha256:${d("a")}`, "spanner", "1.5.59"],
      ["a registry that is not ECR", `registry.example.com/agentx-staging--test-services/spanner-1.5.59/spanner@sha256:${d("a")}`, "spanner", "1.5.59"],
      ["an uppercase environment", `${REGISTRY}/agentx-Staging--test-services/spanner-1.5.59/spanner@sha256:${d("a")}`, "spanner", "1.5.59"],
      ["a tag", `${REGISTRY}/agentx-staging--test-services/spanner-1.5.59/spanner:1.5.59`, "spanner", "1.5.59"],
      ["a Pub/Sub image from the install's ECR (never copied)", `${REGISTRY}/agentx-staging--test-services/pubsub-594.0.0/pubsub@sha256:${d("a")}`, "pubsub", "594.0.0"],
      ["a Docker Hub image for a pack family", `docker.io/library/redis@sha256:${d("a")}`, "spanner", "1.5.59"],
    ] as const) expect(entry(reference, family, version), name).toBe(false);
    expect(gcpPackMirrorMatches("pubsub", "594.0.0", REGISTRY, "agentx-staging--test-services/pubsub-594.0.0/pubsub")).toBe(false);
    // The source form is still accepted, as before.
    const source = OWNER_GCP_PACK_IMAGES.find((image) => image.family === "spanner")!;
    expect(entry(source.reference, "spanner", source.version)).toBe(true);
  });

  it("builds the hosted worker's pack entries: mirrored images by the install's copy, pulled images by Google's registry, the same digests as the pack list, nothing for a group not named", () => {
    expect(gcpPackWorkerEntries(REGISTRY, "staging", "off")).toEqual([]);
    expect(gcpPackWorkerEntries(REGISTRY, "staging", undefined)).toEqual([]);
    expect(gcpPackWorkerEntries(REGISTRY, "staging", "nonsense")).toEqual([]);
    const mirrored = gcpPackWorkerEntries(REGISTRY, "staging", "mirrored");
    expect(mirrored.map((each) => each.family)).toEqual(["spanner", "gcs"]);
    for (const each of mirrored) expect(each.reference.startsWith(`${REGISTRY}/agentx-staging--test-services/`)).toBe(true);
    const pulled = gcpPackWorkerEntries(REGISTRY, "staging", "pulled");
    expect(pulled.map((each) => each.family)).toEqual(["pubsub", "firestore", "datastore", "bigtable"]);
    for (const each of pulled) expect(each.reference).toMatch(/^gcr\.io\/google\.com\/cloudsdktool\/google-cloud-cli@sha256:[a-f0-9]{64}$/u);
    const everything = gcpPackWorkerEntries(REGISTRY, "staging", "mirrored:pulled:bigquery");
    expect(everything).toHaveLength(7);
    // The digest is the image's own, whichever way it is pulled.
    for (const each of everything) {
      const source = OWNER_GCP_PACK_IMAGES.find((image) => image.family === each.family)!;
      expect(each.reference.slice(each.reference.indexOf("@sha256:"))).toBe(source.reference.slice(source.reference.indexOf("@sha256:")));
    }
    expect(() => gcpPackWorkerEntries("docker.io", "staging", "mirrored")).toThrow();
    expect(() => gcpPackWorkerEntries(REGISTRY, "Staging", "mirrored")).toThrow();
  });

  it("the catalog is the same whether an image is copied or pulled: the broker's catalog (source references) and the worker's (copies) key every image by the same repository and digest", () => {
    const keys = (entries: ReturnType<typeof gcpPackWorkerEntries>) => ownerCatalogOf(entries)!.entries.map((each) => `${each.image.repository}@${each.image.digest}`).sort();
    const worker = gcpPackWorkerEntries(REGISTRY, "staging", "mirrored:pulled:bigquery");
    const broker = OWNER_GCP_PACK_IMAGES.map((image) => ({ reference: image.reference, family: image.family, version: image.version }));
    expect(keys(worker)).toEqual(keys(broker));
  });
});

describe("the worker image's CLI answers for the pack", () => {
  it("prints the distinct references for the groups named: the install's copies, and Google's image once for its four families", () => {
    const out = (groups: string) => testServicesMirrorOutput(["pack-refs", REGISTRY, "staging", groups])!;
    expect(out("mirrored").trim().split("\n")).toEqual(gcpPackWorkerEntries(REGISTRY, "staging", "mirrored").map((each) => each.reference));
    expect(out("pulled").trim().split("\n")).toHaveLength(1);
    expect(out("mirrored:pulled").trim().split("\n")).toHaveLength(3);
    expect(out("mirrored:pulled:bigquery").trim().split("\n")).toHaveLength(4);
    expect(out("off")).toBe("");
    expect(out("nonsense")).toBe("");
  });

  it("lists the owner entries of the references that arrived, and only those", () => {
    const all = gcpPackWorkerEntries(REGISTRY, "staging", "mirrored:pulled");
    const sdk = all.find((each) => each.family === "pubsub")!.reference;
    const spanner = all.find((each) => each.family === "spanner")!.reference;
    const listed = JSON.parse(testServicesMirrorOutput(["pack-list", REGISTRY, "staging", "mirrored:pulled", sdk, spanner])!) as Array<{ family: string }>;
    expect(listed.map((each) => each.family).sort()).toEqual(["bigtable", "datastore", "firestore", "pubsub", "spanner"]);
    expect(JSON.parse(testServicesMirrorOutput(["pack-list", REGISTRY, "staging", "mirrored:pulled"])!)).toEqual([]);
    // A reference that is not the pack's, or is of a group that is off, is left out.
    const stranger = `docker.io/library/redis@sha256:${d("4")}`;
    expect(JSON.parse(testServicesMirrorOutput(["pack-list", REGISTRY, "staging", "mirrored", sdk, stranger])!)).toEqual([]);
  });

  it("refuses what it does not take: bad registry, bad environment, no groups, more references than the groups have, a command it does not know; the starters' commands are as they were", () => {
    expect(testServicesMirrorOutput(["pack-refs", "docker.io", "staging", "mirrored"])).toBeUndefined();
    expect(testServicesMirrorOutput(["pack-refs", REGISTRY, "Staging", "mirrored"])).toBeUndefined();
    expect(testServicesMirrorOutput(["pack-refs", REGISTRY, "staging"])).toBeUndefined();
    expect(testServicesMirrorOutput(["pack-refs", REGISTRY, "staging", "mirrored", "extra"])).toBeUndefined();
    expect(testServicesMirrorOutput(["pack-list", REGISTRY, "staging", "pulled", "a", "b"])).toBeUndefined();
    expect(testServicesMirrorOutput(["pack-other", REGISTRY, "staging", "mirrored"])).toBeUndefined();
    expect(testServicesMirrorOutput(["refs", REGISTRY, "staging"])!.trim().split("\n")).toEqual(mirroredStarterEntries(REGISTRY, "staging").map((each) => each.reference));
    expect(JSON.parse(testServicesMirrorOutput(["list", REGISTRY, "staging"])!)).toEqual([]);
  });
});

describe("the hosted catalog with the setting", () => {
  const families = async (env: Record<string, string>) => (await hostedServiceCatalog(env)!())!.entries.map((each) => each.family).sort();
  const starters = ["mongodb", "mysql", "postgres", "postgres", "redis"];

  it("is the starters alone until the setting names a group AND the workers run test services (the starter copies are in place)", async () => {
    expect(await families({ ROVARA_TEST_SERVICES: "1" })).toEqual(starters);
    expect(await families({ ROVARA_TEST_SERVICES: "1", ROVARA_TEST_SERVICES_HOSTED_IMAGES: "mirrored", [GCP_PACK_SETTING_VARIABLE]: "off" })).toEqual(starters);
    // Pack named, but the starter copies are not in place: the workers run no test services at all, so the catalog stays the starters'.
    expect(await families({ ROVARA_TEST_SERVICES: "1", [GCP_PACK_SETTING_VARIABLE]: "mirrored" })).toEqual(starters);
    expect(await families({ ROVARA_TEST_SERVICES: "1", ROVARA_TEST_SERVICES_HOSTED_IMAGES: "none", [GCP_PACK_SETTING_VARIABLE]: "mirrored:pulled" })).toEqual(starters);
    expect(hostedServiceCatalog({ ROVARA_TEST_SERVICES: "0", ROVARA_TEST_SERVICES_HOSTED_IMAGES: "mirrored", [GCP_PACK_SETTING_VARIABLE]: "mirrored" })).toBeUndefined();
  });

  it("adds the groups named, and only those", async () => {
    const on = { ROVARA_TEST_SERVICES: "1", ROVARA_TEST_SERVICES_HOSTED_IMAGES: "mirrored" };
    expect(await families({ ...on, [GCP_PACK_SETTING_VARIABLE]: "mirrored" })).toEqual([...starters, "gcs", "spanner"].sort());
    expect(await families({ ...on, [GCP_PACK_SETTING_VARIABLE]: "pulled" })).toEqual([...starters, "bigtable", "datastore", "firestore", "pubsub"].sort());
    expect(await families({ ...on, [GCP_PACK_SETTING_VARIABLE]: "bigquery" })).toEqual([...starters, "bigquery"].sort());
    expect(await families({ ...on, [GCP_PACK_SETTING_VARIABLE]: "mirrored:pulled:bigquery" })).toHaveLength(12);
    // An unreadable value is no group (fail closed): the hosted setting is stricter than the laptop's list, exactly one of the parameter's values.
    for (const value of ["Mirrored ", "mirrored;pulled", "all", "", "mirrored,pulled"]) expect(await families({ ...on, [GCP_PACK_SETTING_VARIABLE]: value }), value).toEqual(starters);
  });

  it("reads the setting as exactly one of the parameter's non-off values, and only for a worker that runs test services", () => {
    const on = { ROVARA_TEST_SERVICES: "1", ROVARA_TEST_SERVICES_HOSTED_IMAGES: "mirrored" };
    expect(hostedWorkersRunTestServices(on)).toBe(true);
    for (const value of GCP_PACK_PARAMETER_VALUES) expect(hostedGcpPackSetting({ ...on, [GCP_PACK_SETTING_VARIABLE]: value }), value).toBe(value === "off" ? undefined : value);
    for (const value of ["mirrored,pulled", "pulled:mirrored", "Pulled", " pulled", "pulled:pulled", "x"]) expect(hostedGcpPackSetting({ ...on, [GCP_PACK_SETTING_VARIABLE]: value }), value).toBeUndefined();
    expect(hostedGcpPackSetting({ [GCP_PACK_SETTING_VARIABLE]: "pulled" })).toBeUndefined();
    expect(hostedGcpPackSetting({ ROVARA_TEST_SERVICES: "0", ROVARA_TEST_SERVICES_HOSTED_IMAGES: "mirrored", [GCP_PACK_SETTING_VARIABLE]: "pulled" })).toBeUndefined();
  });

  it("the starter list and its guard file are untouched by the setting", () => {
    expect(ownerStarterEntries().map((each) => each.family).sort()).toEqual(starters);
  });
});

describe("the boot configuration", () => {
  const config: Ec2WorkerBootConfig = {
    workspaceId: "11111111-2222-4333-8444-555555555555", generation: 2, volumeId: "vol-0123456789abcdef0", expectNewVolume: false, workerImage: `${REGISTRY}/agentx-staging/worker@sha256:${d("a")}`, invokePublicKey: "QUJD",
    controlPlaneUrl: "https://abc.execute-api.us-west-2.amazonaws.com", modelProvider: "amazon-bedrock", modelId: "m", promptCacheRetention: "long", logGroupName: "/agentx/staging/worker",
  };
  const render = (extra: Partial<Ec2WorkerBootConfig>) => ec2WorkerBootScript({ ...config, ...extra }, "#!/bin/bash\necho boot\n");

  it("renders ROVARA_TEST_SERVICES_GCP_PACK only with test services, only a non-off value of the setting, and otherwise the user data is byte-identical", () => {
    const base = render({ testServices: true });
    expect(base).not.toContain("ROVARA_TEST_SERVICES_GCP_PACK");
    for (const value of GCP_PACK_PARAMETER_VALUES.slice(1)) {
      const rendered = render({ testServices: true, testServicesGcpPack: value });
      expect(rendered).toContain(`export ROVARA_TEST_SERVICES_GCP_PACK='${value}'`);
      expect(rendered.replace(`export ROVARA_TEST_SERVICES_GCP_PACK='${value}'\n`, "")).toBe(base);
    }
    expect(render({})).toBe(render({ testServices: undefined }));
  });

  it("refuses a value that is not one of the setting's, and the pack without test services (nothing reaches the script's shell but a fixed word)", () => {
    for (const bad of ["off", "", "mirrored,pulled", "pulled:mirrored", "mirrored'; touch /x; '", "Mirrored", "mirrored:pulled:bigquery:mirrored"]) expect(() => render({ testServices: true, testServicesGcpPack: bad }), bad).toThrow();
    expect(() => render({ testServicesGcpPack: "mirrored" })).toThrow();
  });
});

describe("the agentx config key", () => {
  it("sets the foundation first and then the control plane, off by default, one of the parameter's values", () => {
    const key = configKey("testServices.gcpPack");
    expect(key.target).toEqual({ kind: "stack-parameter", part: "foundation", parameter: "TestServicesGcpPack", also: [{ part: "control-plane", parameter: "TestServicesGcpPack" }] });
    expect(key.defaultValue).toBe("off");
    for (const value of GCP_PACK_PARAMETER_VALUES) expect(key.parse(value)).toBe(value);
    for (const bad of ["", "on", "mirrored,pulled", "pulled:mirrored", "all", "Mirrored"]) expect(() => key.parse(bad), bad).toThrow();
    expect(CONFIG_KEYS.map((each) => each.key)).toContain("testServices.gcpPack");
  });

  it("is kept across upgrades on both stacks", () => {
    expect(OPERATOR_PARAMETERS.foundation).toContain("TestServicesGcpPack");
    expect(OPERATOR_PARAMETERS["control-plane"]).toContain("TestServicesGcpPack");
  });
});

describe("the copy script's --pack plan", () => {
  it("is the five starters' plan unchanged, and with the pack three more steps: the mirrorable images by digest into their own repositories, never Google's SDK image", () => {
    const starters = mirrorPlan(REGISTRY, "staging");
    expect(starters).toHaveLength(5);
    const withPack = mirrorPlan(REGISTRY, "staging", true);
    expect(withPack.slice(0, 5)).toEqual(starters);
    expect(withPack.slice(5).map((step) => [step.requested, step.target.slice(0, step.target.indexOf(":", REGISTRY.length + 1)), step.digest])).toEqual([
      ["cloud-spanner-emulator/emulator:1.5.59", `${REGISTRY}/agentx-staging--test-services/spanner-1.5.59/spanner`, `sha256:5f71fecd6330211789b75065ade9587d67b3a6b4678e7e5408e42c22f778c63e`],
      ["fsouza/fake-gcs-server:1.56.1", `${REGISTRY}/agentx-staging--test-services/gcs-1.56.1/gcs`, `sha256:797ce226d62f947c009dc40246b30cfb456b8473d8241407f9d6f2c04e4d69ef`],
      ["goccy/bigquery-emulator:0.8.1", `${REGISTRY}/agentx-staging--test-services/bigquery-0.8.1/bigquery`, `sha256:f4e428d265a93dc5ce36c294e1c584c7c9b384117d47ab8ddbb63d8d50b7f393`],
    ]);
    expect(JSON.stringify(withPack)).not.toContain("cloudsdktool");
    for (const step of withPack.slice(5)) expect(step.pinned).toBe(`${step.target.slice(0, step.target.lastIndexOf(":"))}@${step.digest}`);
  });
});
