// The test environment's install switches, and the release's catalog source: which variable turns what on, that only exact values count, and that a catalog nobody trusts never loads.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CATALOG_FILE, CATALOG_SIGNATURE_FILE, CATALOG_SIGNATURE_ALGORITHM, catalogSigningMessage, parseBundlePublicKey, sha256HexOf } from "@agentx/contracts";
import { nightlyHealthEnabled } from "../../packages/broker/src/core/test-env/health-switch.js";
import { savedEnvEnabled } from "../../packages/broker/src/core/test-env/saved-env-switch.js";
import { SHIPPED_CATALOG_FOLDER, SERVICE_CATALOG_DIRECTORY_VARIABLE, releaseServiceCatalogSource } from "../../packages/broker/src/core/test-env/shipped-catalog.js";
import { TEST_SERVICES_UNAVAILABLE_VARIABLE, projectImagesEnabled, testAccountsEnabled } from "../../packages/broker/src/core/test-env/test-services-switch.js";
import { loaderTrusting, pinnedCatalog, testSigner } from "../support/catalog-pinning.js";

describe("the switches", () => {

  it("test accounts, project images, saved environments and nightly health are off unless exactly 1", () => {
    const switches: Array<[string, (env: NodeJS.ProcessEnv) => boolean]> = [
      ["ROVARA_TEST_ACCOUNTS", testAccountsEnabled], ["ROVARA_PROJECT_IMAGES", projectImagesEnabled],
      ["ROVARA_SAVED_ENVIRONMENTS", savedEnvEnabled], ["ROVARA_NIGHTLY_HEALTH", nightlyHealthEnabled],
    ];
    for (const [variable, read] of switches) {
      expect(read({}), variable).toBe(false);
      for (const value of ["true", "", " 1", "1 ", "on", "yes", "0"]) expect(read({ [variable]: value }), `${variable}=${value}`).toBe(false);
      expect(read({ [variable]: "1" }), variable).toBe(true);
    }
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
  it("is nothing while test services are off (the owner's 0, or the host's marker), and reads nothing", () => {
    expect(releaseServiceCatalogSource({ ROVARA_TEST_SERVICES: "0" })).toBeUndefined();
    expect(releaseServiceCatalogSource({ [TEST_SERVICES_UNAVAILABLE_VARIABLE]: "images" })).toBeUndefined();
  });

  it("is nothing for a catalog the release's key did not sign, with no key, or with no files (fail closed)", async () => {
    const { directory, signer } = await shipped();
    const env = { ROVARA_TEST_SERVICES: "1", [SERVICE_CATALOG_DIRECTORY_VARIABLE]: directory };
    expect(await releaseServiceCatalogSource(env, loaderTrusting(testSigner().publicKeyPem))!()).toBeUndefined();
    expect(await releaseServiceCatalogSource(env, loaderTrusting())!()).toBeUndefined();
    expect(await releaseServiceCatalogSource({ ...env, [SERVICE_CATALOG_DIRECTORY_VARIABLE]: join(directory, "nowhere") }, loaderTrusting(signer.publicKeyPem))!()).toBeUndefined();
  });

});
