// Where a nightly coverage map lives in the artifact bucket : `nightly-maps/<company>/<project>/<digest>.json`. The company and project parts are hashes (a name could carry a character a key must not), so a project's maps are
// one prefix and a company's are one prefix, which is what archiving a project and closing a company delete (rovara-code/evidence-erase.ts) and what the bucket's 30 day lifecycle rule matches (`nightly-maps/`).
import { createHash } from "node:crypto";
import { canonicalJson } from "@agentx/contracts";

const sha = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
export const NIGHTLY_MAPS_PREFIX = "nightly-maps/";
/** Every map of a company. */
export const nightlyMapsOfOrg = (orgId: string): string => `${NIGHTLY_MAPS_PREFIX}${sha(orgId).slice(0, 40)}/`;
/** Every map of a project. */
export const nightlyMapsOfProject = (orgId: string, project: string): string => `${nightlyMapsOfOrg(orgId)}${sha([orgId, project]).slice(0, 40)}/`;
/** One map. */
export const nightlyMapKey = (orgId: string, project: string, digest: string): string => `${nightlyMapsOfProject(orgId, project)}${digest}.json`;
