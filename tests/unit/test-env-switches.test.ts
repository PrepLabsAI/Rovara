// The test environment's install switches, and the release's catalog source: which variable turns what on, that only exact values count, and that a catalog nobody trusts never loads.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CATALOG_FILE, CATALOG_SIGNATURE_FILE, CATALOG_SIGNATURE_ALGORITHM, catalogSigningMessage, parseBundlePublicKey, sha256HexOf } from "@rovara-code/contracts";
import { nightlyHealthEnabled } from "../../packages/core/src/core/test-env/health-switch.js";
import { savedEnvEnabled } from "../../packages/core/src/core/test-env/saved-env-switch.js";
import { SHIPPED_CATALOG_FOLDER, SERVICE_CATALOG_DIRECTORY_VARIABLE, releaseServiceCatalogSource, shippedCatalogDirectory } from "../../packages/core/src/core/test-env/shipped-catalog.js";
import { testEnvironmentEnabled } from "../../packages/core/src/core/test-env/switch.js";
import { projectImagesEnabled, testAccountsEnabled, testServicesEnabled } from "../../packages/core/src/core/test-env/test-services-switch.js";
import { loaderTrusting, pinnedCatalog, testSigner } from "../support/catalog-pinning.js";

describe("the switches", () => {
  it("the test environment is on unless exactly 0: nothing happens until an environment is approved", () => {
    expect(testEnvironmentEnabled({})).toBe(true);
    for (const value of ["1", "true", "", " 0", "false"]) expect(testEnvironmentEnabled({ ROVARA_TEST_ENVIRONMENT: value }), value).toBe(true);
    expect(testEnvironmentEnabled({ ROVARA_TEST_ENVIRONMENT: "0" })).toBe(false);
  });

  it("test services, test accounts, project images, saved environments and nightly health are off unless exactly 1", () => {
    const switches: Array<[string, (env: NodeJS.ProcessEnv) => boolean]> = [
      ["ROVARA_TEST_SERVICES", testServicesEnabled], ["ROVARA_TEST_ACCOUNTS", testAccountsEnabled], ["ROVARA_PROJECT_IMAGES", projectImagesEnabled],
      ["ROVARA_SAVED_ENVIRONMENTS", savedEnvEnabled], ["ROVARA_NIGHTLY_HEALTH", nightlyHealthEnabled],
    ];
    for (const [variable, read] of switches) {
      expect(read({}), variable).toBe(false);
      for (const value of ["true", "", " 1", "1 ", "on", "yes", "0"]) expect(read({ [variable]: value }), `${variable}=${value}`).toBe(false);
      expect(read({ [variable]: "1" }), variable).toBe(true);
    }
  });

  it("each switch reads only its own variable, and test services do not imply accounts or images", () => {
    expect(testAccountsEnabled({ ROVARA_TEST_SERVICES: "1" })).toBe(false);
    expect(projectImagesEnabled({ ROVARA_TEST_SERVICES: "1" })).toBe(false);
    expect(testServicesEnabled({ ROVARA_TEST_ACCOUNTS: "1" })).toBe(false);
    expect(savedEnvEnabled({ ROVARA_TEST_SERVICES: "1", ROVARA_TEST_ENVIRONMENT: "1" })).toBe(false);
  });
});

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function shipped() {
  const root = await mkdtemp(join(tmpdir(), "rovara-catalog-"));
  roots.push(root);
  const directory = join(root, SHIPPED_CATALOG_FOLDER);
  await mkdir(directory);
  const signer = testSigner();
  const catalogBytes = Buffer.from(`${JSON.stringify(pinnedCatalog(), null, 2)}\n`, "utf8");
  const signature = { schemaVersion: 1, algorithm: CATALOG_SIGNATURE_ALGORITHM, keyId: parseBundlePublicKey(signer.publicKeyPem).keyId, catalogSha256: sha256HexOf(catalogBytes), signature: (await signer.sign(catalogSigningMessage(catalogBytes))).toString("base64") };
  await writeFile(join(directory, CATALOG_FILE), catalogBytes);
  await writeFile(join(directory, CATALOG_SIGNATURE_FILE), JSON.stringify(signature));
  return { directory, signer };
}

describe("the release's catalog source", () => {
  it("is nothing while test services are off, and reads nothing", () => {
    expect(releaseServiceCatalogSource({})).toBeUndefined();
    expect(releaseServiceCatalogSource({ ROVARA_TEST_SERVICES: "true" })).toBeUndefined();
  });

  it("loads the shipped, signed catalog with services on and the release's key", async () => {
    const { directory, signer } = await shipped();
    const source = releaseServiceCatalogSource({ ROVARA_TEST_SERVICES: "1", [SERVICE_CATALOG_DIRECTORY_VARIABLE]: directory }, loaderTrusting(signer.publicKeyPem));
    expect((await source!())?.pinned).toBe(true);
  });

  it("is nothing for a catalog the release's key did not sign, with no key, or with no files (fail closed)", async () => {
    const { directory, signer } = await shipped();
    const env = { ROVARA_TEST_SERVICES: "1", [SERVICE_CATALOG_DIRECTORY_VARIABLE]: directory };
    expect(await releaseServiceCatalogSource(env, loaderTrusting(testSigner().publicKeyPem))!()).toBeUndefined();
    expect(await releaseServiceCatalogSource(env, loaderTrusting())!()).toBeUndefined();
    expect(await releaseServiceCatalogSource({ ...env, [SERVICE_CATALOG_DIRECTORY_VARIABLE]: join(directory, "nowhere") }, loaderTrusting(signer.publicKeyPem))!()).toBeUndefined();
  });

  it("trusts nothing today: the contract's key lists are empty, so a signed catalog does not load (fail closed)", async () => {
    const { directory } = await shipped();
    const source = releaseServiceCatalogSource({ ROVARA_TEST_SERVICES: "1", [SERVICE_CATALOG_DIRECTORY_VARIABLE]: directory });
    expect(await source!()).toBeUndefined();
  });

  it("names its directory from the variable, else beside the working directory", () => {
    expect(shippedCatalogDirectory({ [SERVICE_CATALOG_DIRECTORY_VARIABLE]: "/srv/catalog" })).toBe("/srv/catalog");
    expect(shippedCatalogDirectory({})).toBe(join(process.cwd(), "service-catalog"));
  });
});
