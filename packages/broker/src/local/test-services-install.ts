// Test services at `rovara up`: what the install does at start-up when the owner turned them on (`ROVARA_TEST_SERVICES=1`). It fails CLOSED and says why.
//   - A build that compiles in a catalog signing key (Cloud's) uses the SIGNED catalog and nothing else: a registry the catalog images are served from, a catalog that verifies, and at least one image on this machine, or the
//     worker is told nothing, offers no test services, and refuses any run that needs them. The owner's list is never read there, and a catalog that fails to verify never falls back to it.
//   - A build with no signing key (Code) uses the OWNER'S list (`test-services-owner-list.ts`): the built-in starter images, the images the owner approved on the page and `ROVARA_TEST_SERVICE_IMAGES`, each pinned by digest.
import { networkInterfaces } from "node:os";
import { OWNER_LIST_CATALOG_ENV, OWNER_LIST_REGISTRY, catalogSigningKeysCompiledIn, ownerCatalogOf, ownerListReferences, type VerifiedCatalog } from "@agentx/contracts";
import type { DockerRunner } from "./docker-runner.js";
import { NO_IMAGES_SENTENCE, resolveOwnerImages, type OwnerImageService } from "./test-services-owner-list.js";
import type { ServiceCatalogSource } from "../core/test-env/dependency-plan.js";
import { loadLocalServiceCatalog, localTestServicesFrom, prepareTestServiceImages, type LocalTestServices } from "./test-services.js";
import { releaseServiceCatalogSource, shippedCatalogDirectory } from "../core/test-env/shipped-catalog.js";
import { testServicesEnabled } from "../core/test-env/test-services-switch.js";

/** Where the catalog's images are served from (`host[:port]`): the owner's own mirror. Code names none. */
export const TEST_SERVICES_REGISTRY_VARIABLE = "ROVARA_TEST_SERVICES_REGISTRY";
/** The named environment in `rovara-catalog/<env>/svc/...`. Default `local`. */
export const TEST_SERVICES_CATALOG_ENV_VARIABLE = "ROVARA_TEST_SERVICES_CATALOG_ENV";

export const NO_REGISTRY_SENTENCE = `Test services are not available: no registry to take the service images from is named (set ${TEST_SERVICES_REGISTRY_VARIABLE}).`;

export const RANGE_IN_USE_SENTENCE = "Test services are not available: this computer already uses addresses in 172.30.0.0/16, which is where Rovara puts the networks of a test run, so a run's network could take the place of a real one.";

/**
 * Whether this computer has an address in 172.30.0.0/16, the range the run networks are made in (`172.30.<slot>.0/24`). A run's bridge takes the route for its slot, so a LAN or a VPN that already uses that range
 * would be shadowed for the machine that runs Docker. Only this computer's own interfaces are read (the machine `rovara up` runs on; with Colima or Docker Desktop the daemon is in a VM beside it).
 */
export function hostUsesRunRange(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): boolean {
  return Object.values(interfaces).some((list) => (list ?? []).some((entry) => entry.family === "IPv4" && /^172\.30\.\d{1,3}\.\d{1,3}$/u.test(entry.address)));
}

export interface LocalTestServicesInstall {
  /** Given to `DockerWorkerMachines`; undefined when nothing can be started. */
  services: LocalTestServices | undefined;
  /** The verified catalog, when there is one. */
  catalog: VerifiedCatalog | undefined;
  /** One plain sentence saying why services are not offered, or undefined when they are (or are off). */
  unavailable: string | undefined;
  /** Where the broker reads the catalog a dependency is pinned from: the signed one, or the owner list's. Present exactly when `catalog` is. */
  catalogSource?: ServiceCatalogSource | undefined;
  /** `signed`: this build has a catalog signing key and uses only the signed catalog. `owner`: Code, from the owner's approved list. Undefined while test services are off. */
  mode?: "signed" | "owner" | undefined;
  /** The owner's list, for the test environment page to approve images on (owner mode only, whether or not any image is in effect yet). */
  ownerImages?: OwnerImageService | undefined;
}

export async function prepareLocalTestServices(input: {
  environment: NodeJS.ProcessEnv; stateDirectory: string; docker: DockerRunner; interfaces?: ReturnType<typeof networkInterfaces>; log?: (entry: Record<string, unknown>) => void;
  /** The owner's list (Code). Without it a build with no signing key has no way to offer test services. */
  ownerImages?: OwnerImageService | undefined;
  now?: () => number;
  /** Tests only: whether this build has a catalog signing key, and how the signed catalog is loaded. Production passes neither (the compiled-in keys decide). */
  signedKeysPresent?: () => boolean;  // default: the compiled-in key LIST has an entry, whether or not it validates
  loadCatalog?: typeof loadLocalServiceCatalog;
}): Promise<LocalTestServicesInstall> {
  const off: LocalTestServicesInstall = { services: undefined, catalog: undefined, unavailable: undefined };
  if (!testServicesEnabled(input.environment)) return off;
  const log = input.log ?? (() => undefined);
  const signed = (input.signedKeysPresent ?? catalogSigningKeysCompiledIn)();
  const mode = signed ? "signed" as const : "owner" as const;
  const refuse = (sentence: string, reason: string): LocalTestServicesInstall => { log({ component: "test-services", event: "test_services.unavailable", reason, message: sentence }); return { services: undefined, catalog: undefined, unavailable: sentence, mode, ...(signed || input.ownerImages === undefined ? {} : { ownerImages: input.ownerImages }) }; };
  if (hostUsesRunRange(input.interfaces)) return refuse(RANGE_IN_USE_SENTENCE, "range_in_use");
  if (!signed) return prepareFromOwnerList(input, refuse, log);
  const registry = input.environment[TEST_SERVICES_REGISTRY_VARIABLE]?.trim();
  if (registry === undefined || registry === "") return refuse(NO_REGISTRY_SENTENCE, "no_registry");
  const loaded = await (input.loadCatalog ?? loadLocalServiceCatalog)(shippedCatalogDirectory(input.environment));
  if (!loaded.ok) return refuse(loaded.sentence, loaded.reason);
  const catalogEnv = input.environment[TEST_SERVICES_CATALOG_ENV_VARIABLE]?.trim() || "local";
  const prepared = await prepareTestServiceImages({ docker: input.docker, catalog: loaded.catalog, registry, catalogEnv, stateDirectory: input.stateDirectory });
  const services = localTestServicesFrom({ registry, catalogEnv, prepared });
  if (services === undefined) return { services: undefined, catalog: loaded.catalog, unavailable: "Test services are not available: none of the catalog's images could be pulled to this computer.", catalogSource: releaseServiceCatalogSource(input.environment), mode };
  return { services, catalog: loaded.catalog, unavailable: undefined, catalogSource: releaseServiceCatalogSource(input.environment), mode };
}

/** Code: the owner's list. The starter images, the owner's approvals and the env list that are on this computer by digest are what the guard lets start and what the worker is told. */
async function prepareFromOwnerList(
  input: { environment: NodeJS.ProcessEnv; docker: DockerRunner; ownerImages?: OwnerImageService | undefined; now?: (() => number) | undefined },
  refuse: (sentence: string, reason: string) => LocalTestServicesInstall,
  log: (entry: Record<string, unknown>) => void,
): Promise<LocalTestServicesInstall> {
  const service = input.ownerImages;
  if (service === undefined) return refuse(NO_IMAGES_SENTENCE, "no_owner_list");
  const resolved = await resolveOwnerImages({ service, environment: input.environment, docker: input.docker, now: input.now ?? Date.now, log });
  service.setInEffect(resolved.entries.map((entry) => entry.reference), resolved.envRequested);
  const catalog = ownerCatalogOf(resolved.entries);
  if (catalog === undefined) return refuse(NO_IMAGES_SENTENCE, "no_owner_images");
  const services: LocalTestServices = { registry: OWNER_LIST_REGISTRY, catalogEnv: OWNER_LIST_CATALOG_ENV, images: ownerListReferences(resolved.entries), ownerImages: resolved.entries };
  return { services, catalog, unavailable: undefined, catalogSource: async () => catalog, mode: "owner", ownerImages: service };
}
