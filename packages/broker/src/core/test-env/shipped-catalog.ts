// Test services: the signed service image catalog this release ships, as the broker reads it. `releaseServiceCatalogSource` is the one place the dependency wiring asks for it; with the test services
// switch off it returns nothing and reads nothing, so the plain flow is untouched.
//
// The keys are the CONTRACT's (catalog-trust.ts): compiled in, and empty until the owner names them. With an empty list no catalog verifies, no dependency can be pinned, and every run with dependencies is
// refused in fixed words (fail closed). The release puts `catalog.json` and `catalog.sig.json` in one folder: `ROVARA_SERVICE_CATALOG_DIR`, else `service-catalog` under the working directory. A missing file
// is a refusal, not a crash. Code has no cloud account: the verifier's trust context carries none.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CATALOG_FILE, CATALOG_SIGNATURE_FILE, type loadSignedCatalog } from "@agentx/contracts";
import { serviceCatalogSourceOf, type ServiceCatalogSource } from "./dependency-plan.js";
import { testServicesEnabled } from "./test-services-switch.js";

export const SHIPPED_CATALOG_FOLDER = "service-catalog";
export const SERVICE_CATALOG_DIRECTORY_VARIABLE = "ROVARA_SERVICE_CATALOG_DIR";

/** The directory of the shipped catalog. */
export const shippedCatalogDirectory = (env: NodeJS.ProcessEnv = process.env): string => env[SERVICE_CATALOG_DIRECTORY_VARIABLE] ?? join(process.cwd(), SHIPPED_CATALOG_FOLDER);

/** The signed catalog the release ships, or undefined while test services are off. Reads the two files once, on first use. `load` is a test port (see `serviceCatalogSourceOf`); production passes none, so only the contract's compiled-in keys count. */
export function releaseServiceCatalogSource(env: NodeJS.ProcessEnv = process.env, load?: typeof loadSignedCatalog): ServiceCatalogSource | undefined {
  if (!testServicesEnabled(env)) return undefined;
  const directory = shippedCatalogDirectory(env);
  return serviceCatalogSourceOf({
    read: async () => ({ catalogBytes: await readFile(join(directory, CATALOG_FILE)), signatureBytes: await readFile(join(directory, CATALOG_SIGNATURE_FILE)) }),
    trust: () => ({ runningAccountId: undefined }),
    onRefused: (reason) => console.log(JSON.stringify({ component: "broker", event: "test_services.catalog_refused", reason })),
    ...(load === undefined ? {} : { load }),
  });
}
