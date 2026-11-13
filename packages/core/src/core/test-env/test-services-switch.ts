// Test services: the install switches for dependencies, test accounts and project images (see `switch.ts` for the variables). Leaf module (no broker imports). Off is today's flow, byte for byte:
// nothing new is reachable and every refusal stays as it is.
import { PROJECT_IMAGES_VARIABLE, TEST_ACCOUNTS_VARIABLE, TEST_SERVICES_VARIABLE, optIn } from "./switch.js";

/** Whether dependencies get a backing for test runs. Anything but exactly "1" is off. */
export const testServicesEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => optIn(env, TEST_SERVICES_VARIABLE);

/** Whether a project may use the customer's own test accounts. Anything but exactly "1" is off. It does not imply test services: a reader that needs both asks both. */
export const testAccountsEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => optIn(env, TEST_ACCOUNTS_VARIABLE);

/** Whether a project may bring its own images. Anything but exactly "1" is off. It does not imply test services: a reader that needs both asks both. */
export const projectImagesEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => optIn(env, PROJECT_IMAGES_VARIABLE);
