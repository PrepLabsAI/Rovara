// Rovara local AWS's env file for a wide plan: the planned services as one list (`ROVARA_AWS_PLANNED_SERVICES`, canonical keys), and, for one more release, the old fork's per-service switches exactly as before so the
// image that is shipped today keeps working. Also the worker's advertised features and the engine pin on the catalog entry.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TEST_SERVICES_AWS_ALL_SERVICES_FEATURE, TEST_SERVICES_AWS_PLAN_FEATURE, WORKER_INVOCATION_FEATURES, catalogPrepullList } from "@agentx/contracts";
import { LOCAL_AWS_FORK_KEYS_OF, LOCAL_AWS_SERVICE_KEYS, localAwsEnvLines, newLocalAwsCredentials } from "../../packages/worker/src/service-helpers.js";
import { repoAwsEndpointNames } from "../../packages/worker/src/repo-aws-endpoints.js";
import { pinnedCatalog, verifiedCatalog } from "../support/catalog-pinning.js";
import { forgetEmulatorImageCache, testServicesAdvertisedFeatures } from "../../packages/worker/src/test-services-run.js";

const credentials = newLocalAwsCredentials();
const lines = (awsServices?: string[]) => localAwsEnvLines({ credentials, address: "172.30.1.2", region: "us-east-1", aliases: ["aws"], port: 4566, awsServices });
const switches = (list: string[]) => list.filter((line) => line.startsWith("ROVARA_AWS_SERVICES_") && line.endsWith("_ENABLED=false"));

describe("the env file of Rovara local AWS", () => {
  it("lists the planned services by key, and the fork's switches are the same lines as before for s3, sqs and dynamodb", () => {
    const list = lines(["s3", "sqs", "dynamodb"]);
    expect(list).toContain("ROVARA_AWS_PLANNED_SERVICES=s3,sqs,dynamodb");
    // What the old list was for this plan: every fork key but the three, in the fork's order.
    const expected = LOCAL_AWS_SERVICE_KEYS.filter((key) => !["s3", "sqs", "dynamodb"].includes(key)).map((key) => `ROVARA_AWS_SERVICES_${key.toUpperCase()}_ENABLED=false`);
    expect(switches(list)).toEqual(expected);
    expect(switches(list)).toHaveLength(15);
  });
  it("a wide plan: canonical keys in the list (a legacy spelling is read as its key), and a fork switch left on for each service the fork has", () => {
    const list = lines(["s3", "secretsmanager", "events", "sfn", "ec2"]);
    expect(list).toContain("ROVARA_AWS_PLANNED_SERVICES=s3,secrets-manager,eventbridge,sfn,ec2");
    const off = switches(list);
    for (const forkKey of ["s3", "secretsmanager", "eventbridge", "eventbridgev2", "stepfunctions"]) expect(off).not.toContain(`ROVARA_AWS_SERVICES_${forkKey.toUpperCase()}_ENABLED=false`);
    for (const forkKey of ["sqs", "dynamodb", "sns", "kms"]) expect(off).toContain(`ROVARA_AWS_SERVICES_${forkKey.toUpperCase()}_ENABLED=false`);
    // `ec2` is not a service of the fork: nothing to switch on for it, and it is still planned.
    expect(Object.hasOwn(LOCAL_AWS_FORK_KEYS_OF, "ec2")).toBe(false);
  });
  it("keeps the run contract lines, every value plain, and no planned list when the plan names none (the development default)", () => {
    const list = lines(["sns"]);
    expect(list.slice(0, 7)).toEqual([
      "QUARKUS_HTTP_HOST=172.30.1.2", "ROVARA_AWS_BASE_URL=http://aws:4566", `ROVARA_AWS_AUTH_PRESIGN_SECRET=${credentials.password}`, `ROVARA_AWS_SERVICES_SQS_RECEIPT_HANDLE_SECRET=${credentials.sqsReceiptSecret}`,
      `ROVARA_AWS_CONTROL_TOKEN=${credentials.controlToken}`, "ROVARA_AWS_DEFAULT_REGION=us-east-1", "ROVARA_AWS_HOSTNAME=aws",
    ]);
    for (const line of list) expect(line).toMatch(/^[A-Z_0-9]+=[\x21-\x7e]{1,2048}$/u);
    expect(lines().some((line) => line.startsWith("ROVARA_AWS_PLANNED_SERVICES="))).toBe(false);
    expect(switches(lines())).toEqual([]);
  });
  it("refuses a service the table does not know, a service twice (a legacy spelling and its key are one), an empty list and a list past 64", () => {
    for (const bad of [["nosuchservice"], ["s3", "s3"], ["secretsmanager", "secrets-manager"], [], ["constructor"], Array.from({ length: 65 }, (_v, index) => `svc${String(index)}`)]) {
      expect(() => lines(bad), JSON.stringify(bad).slice(0, 40)).toThrow(RangeError);
    }
  });
});

describe("the features a worker advertises", () => {
  afterEach(() => forgetEmulatorImageCache());
  const IMAGE = `registry.example.test/agentx/worker@sha256:${"b".repeat(64)}`;
  const environment = { AGENTX_TEST_SERVICES_REGISTRY: "123456789012.dkr.ecr.us-west-2.amazonaws.com", AGENTX_TEST_SERVICES_ENV: "test", AGENTX_TEST_SERVICES_RUN_DIR: "/run/rovara", AGENTX_SANDBOX_IMAGE: IMAGE, AGENTX_WORKER_IMAGE: IMAGE };
  it("the all-services feature is a contract feature, and a worker that can run an emulated plan advertises it beside the AWS plan feature (never without it)", async () => {
    expect(WORKER_INVOCATION_FEATURES).toContain(TEST_SERVICES_AWS_ALL_SERVICES_FEATURE);
    // No test-services configuration: neither feature.
    expect(testServicesAdvertisedFeatures({})).toEqual([]);
    const dir = await mkdtemp(join(tmpdir(), "features-"));
    try {
      const verified = verifiedCatalog(pinnedCatalog());
      const shipped = { catalog: join(dir, "catalog.json"), prepull: join(dir, "prepull.json") };
      await writeFile(shipped.catalog, JSON.stringify(pinnedCatalog()));
      await writeFile(shipped.prepull, JSON.stringify(catalogPrepullList(verified)));
      const features = testServicesAdvertisedFeatures(environment, shipped);
      expect(features).toContain(TEST_SERVICES_AWS_PLAN_FEATURE);
      expect(features).toContain(TEST_SERVICES_AWS_ALL_SERVICES_FEATURE);
      // The emulator image did not pre-pull: no emulated plan can run, so neither feature.
      forgetEmulatorImageCache();
      const none = testServicesAdvertisedFeatures({ ...environment, AGENTX_TEST_SERVICES_NOT_PULLED: "svc/local-aws" }, shipped);
      expect(none).not.toContain(TEST_SERVICES_AWS_PLAN_FEATURE);
      expect(none).not.toContain(TEST_SERVICES_AWS_ALL_SERVICES_FEATURE);
      // An empty prepull list: the catalog pins an emulator image that is not here.
      forgetEmulatorImageCache();
      await writeFile(shipped.prepull, JSON.stringify({ ...catalogPrepullList(verified), images: [] }));
      const empty = testServicesAdvertisedFeatures(environment, shipped);
      expect(empty).not.toContain(TEST_SERVICES_AWS_ALL_SERVICES_FEATURE);
      expect(empty).not.toContain(TEST_SERVICES_AWS_PLAN_FEATURE);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the endpoint variables a repository's own settings set", () => {
  let dir: string | undefined;
  afterEach(async () => { if (dir !== undefined) await rm(dir, { recursive: true, force: true }); dir = undefined; });
  it("reads their names from the `.env` files and settings files, never a value, and an empty folder costs nothing", async () => {
    dir = await mkdtemp(join(tmpdir(), "repo-endpoints-"));
    expect(await repoAwsEndpointNames({ repositoryPaths: [dir] })).toEqual([]);
    await writeFile(join(dir, ".env"), "AWS_ENDPOINT_URL_SNS=http://localhost:4566\nAWS_ENDPOINT_URL_SECRETS_MANAGER=http://localhost:4566\nDATABASE_URL=postgres://u:p@h/db\nAWS_ENDPOINT_URL=http://localhost:4566\n");
    const names = await repoAwsEndpointNames({ repositoryPaths: [dir, join(dir, "does-not-exist")] });
    expect(names).toEqual(["AWS_ENDPOINT_URL_SECRETS_MANAGER", "AWS_ENDPOINT_URL_SNS"]);
  });
});
