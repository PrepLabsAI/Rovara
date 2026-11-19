// Test services: the install switches for dependencies, test accounts and project images (see `switch.ts` for the variables). Leaf module (no broker imports).
//
// DEC 254z-amend3 (2026-11-17): test services are ON by default, everywhere, unless the owner says exactly "0" (`ROVARA_TEST_SERVICES=0` on a laptop, the stack setting `td=0` on AWS). Being switched on is not the same as
// being able to run them: the HOST says when it cannot (`rovara up` after its own checks, the hosted broker at start) by setting `ROVARA_TEST_SERVICES_UNAVAILABLE` to one fixed reason code. While that marker is set the
// install behaves exactly as with the switch off (no dependency is proposed, planned or started), and a task whose approved environment lists dependencies says, in fixed words, that test services are not available here
// and why (`usable.ts`). The marker is the host's alone: an owner opts out with the switch, never with the marker.
import { PROJECT_IMAGES_VARIABLE, TEST_ACCOUNTS_VARIABLE, TEST_SERVICES_VARIABLE, optIn } from "./switch.js";

/** Set by the host, never by an owner: test services are switched on but cannot run on this install. Its value is one of TEST_SERVICES_UNAVAILABLE_REASONS; anything else set counts as `other`. */
export const TEST_SERVICES_UNAVAILABLE_VARIABLE = "ROVARA_TEST_SERVICES_UNAVAILABLE";

/**
 * Why the host cannot run test services, as a closed list (the evidence and the state answer show the matching words, never the value itself):
 *   workers   the install's workers cannot start them (hosted Code today: its EC2 workers boot without the test-services stage);
 *   network   this computer already uses 172.30.0.0/16, where a test run puts its networks;
 *   images    no service image can be used here (the signed catalog does not verify, no registry is named, or no image is in effect);
 *   other     anything else, including a marker value this build does not know.
 */
export const TEST_SERVICES_UNAVAILABLE_REASONS = ["workers", "network", "images", "other"] as const;
export type TestServicesUnavailableReason = (typeof TEST_SERVICES_UNAVAILABLE_REASONS)[number];

/** The fixed sentence for each reason. It starts with the words the owner chose ("Test services not available here") and never holds a value from the environment. */
export const TEST_SERVICES_UNAVAILABLE_WORDS: Readonly<Record<TestServicesUnavailableReason, string>> = {
  workers: "Test services not available here: this install's workers cannot start them yet",
  network: "Test services not available here: this computer already uses addresses in 172.30.0.0/16, where test runs put their networks",
  images: "Test services not available here: no service image can be used on this install",
  other: "Test services not available here: something they need is missing on this install",
};

/** Whether the owner left test services on: anything but exactly "0" is on (unset, empty, "1", "true" and " 0" are on). */
export const testServicesSwitchedOn = (env: NodeJS.ProcessEnv = process.env): boolean => env[TEST_SERVICES_VARIABLE] !== "0";

/**
 * Why test services cannot run here although they are switched on, or undefined (they can, or they are switched off). Any value of the marker counts, the empty one included (fail closed); one this build does not know is
 * `other`.
 */
export function testServicesUnavailable(env: NodeJS.ProcessEnv = process.env): TestServicesUnavailableReason | undefined {
  if (!testServicesSwitchedOn(env)) return undefined;
  const marker = env[TEST_SERVICES_UNAVAILABLE_VARIABLE];
  if (marker === undefined) return undefined;
  return (TEST_SERVICES_UNAVAILABLE_REASONS as readonly string[]).includes(marker) ? marker as TestServicesUnavailableReason : "other";
}

/** Whether dependencies get a backing for test runs: switched on (anything but exactly "0") AND the host has not said it cannot run them. */
export const testServicesEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => testServicesSwitchedOn(env) && env[TEST_SERVICES_UNAVAILABLE_VARIABLE] === undefined;

/** Whether a project may use the customer's own test accounts. Anything but exactly "1" is off. It does not imply test services: a reader that needs both asks both. */
export const testAccountsEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => optIn(env, TEST_ACCOUNTS_VARIABLE);

/** Whether a project may bring its own images. Anything but exactly "1" is off. It does not imply test services: a reader that needs both asks both. */
export const projectImagesEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => optIn(env, PROJECT_IMAGES_VARIABLE);
