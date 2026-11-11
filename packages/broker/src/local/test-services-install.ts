// Test services at `rovara up`: what the install does at start-up when the owner turned them on (`ROVARA_TEST_SERVICES=1`). It fails CLOSED and says why: without a registry the catalog images are served from, a
// signed catalog this release trusts, and at least one image on this machine, the worker is told nothing, offers no test services, and refuses any run that needs them. Nothing is pulled until all three hold.
import { networkInterfaces } from "node:os";
import type { VerifiedCatalog } from "@agentx/contracts";
import type { DockerRunner } from "./docker-runner.js";
import { loadLocalServiceCatalog, localTestServicesFrom, prepareTestServiceImages, type LocalTestServices } from "./test-services.js";
import { shippedCatalogDirectory } from "../core/test-env/shipped-catalog.js";
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
}

export async function prepareLocalTestServices(input: {
  environment: NodeJS.ProcessEnv; stateDirectory: string; docker: DockerRunner; interfaces?: ReturnType<typeof networkInterfaces>; log?: (entry: Record<string, unknown>) => void;
}): Promise<LocalTestServicesInstall> {
  const off: LocalTestServicesInstall = { services: undefined, catalog: undefined, unavailable: undefined };
  if (!testServicesEnabled(input.environment)) return off;
  const log = input.log ?? (() => undefined);
  const refuse = (sentence: string, reason: string): LocalTestServicesInstall => { log({ component: "test-services", event: "test_services.unavailable", reason }); return { services: undefined, catalog: undefined, unavailable: sentence }; };
  if (hostUsesRunRange(input.interfaces)) return refuse(RANGE_IN_USE_SENTENCE, "range_in_use");
  const registry = input.environment[TEST_SERVICES_REGISTRY_VARIABLE]?.trim();
  if (registry === undefined || registry === "") return refuse(NO_REGISTRY_SENTENCE, "no_registry");
  const loaded = await loadLocalServiceCatalog(shippedCatalogDirectory(input.environment));
  if (!loaded.ok) return refuse(loaded.sentence, loaded.reason);
  const catalogEnv = input.environment[TEST_SERVICES_CATALOG_ENV_VARIABLE]?.trim() || "local";
  const prepared = await prepareTestServiceImages({ docker: input.docker, catalog: loaded.catalog, registry, catalogEnv, stateDirectory: input.stateDirectory });
  const services = localTestServicesFrom({ registry, catalogEnv, prepared });
  if (services === undefined) return { services: undefined, catalog: loaded.catalog, unavailable: "Test services are not available: none of the catalog's images could be pulled to this computer." };
  return { services, catalog: loaded.catalog, unavailable: undefined };
}
