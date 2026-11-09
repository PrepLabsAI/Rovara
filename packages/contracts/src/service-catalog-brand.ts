// Test services, TS19: the RUNTIME brands behind `resolveCatalogImage`. INTERNAL: this module is not exported from `index.ts` (the package's exports map allows only `.` and `./web`), so no caller can register
// anything; only the functions in this package that really verify something do.
//
// A TypeScript brand is a compile-time promise. These WeakSets are the runtime one: a catalog is "verified" only if `loadSignedCatalog` returned that very object, and a digest check is a "mirror check" or a "bundle
// check" only if `checkMirrorServesDigest`/`checkCatalogMirror` or `checkBundleImages` returned that very object. A hand-built object of the same shape, a raw `ServiceCatalog` and a `structuredClone` copy of a real
// result are all absent from the sets, so `resolveCatalogImage` refuses them. Everything registered is deep-frozen first, so a holder cannot change a verified result after the fact.
//
// Imports from the other catalog modules are TYPES only (erased), so there is no import cycle at run time.
import type { BundleImageCheck, MirrorCheck, VerifiedCatalog } from "./service-catalog-images.js";
import type { ServiceCatalog } from "./service-catalog.js";

const verifiedCatalogs = new WeakSet<object>();
const mirrorChecks = new WeakSet<object>();
const bundleChecks = new WeakSet<object>();

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Marks a catalog as verified (its signature held over the exact bytes and the strict schema parsed it): freezes it and registers it. Called only by `loadSignedCatalog`. */
export function registerVerifiedCatalog(catalog: ServiceCatalog): VerifiedCatalog {
  deepFreeze(catalog);
  verifiedCatalogs.add(catalog);
  return catalog as VerifiedCatalog;
}

/** Marks the result of a registry digest check (passed or failed): freezes it and registers it. Called only by the registry checks. */
export function registerMirrorCheck(check: MirrorCheck): MirrorCheck {
  deepFreeze(check);
  mirrorChecks.add(check);
  return check;
}

/** Marks the result of a bundle digest check (passed or failed): freezes it and registers it. Called only by `checkBundleImages`. */
export function registerBundleCheck(check: BundleImageCheck): BundleImageCheck {
  deepFreeze(check);
  bundleChecks.add(check);
  return check;
}

export const isVerifiedCatalog = (value: unknown): boolean => typeof value === "object" && value !== null && verifiedCatalogs.has(value);
export const isMirrorCheck = (value: unknown): boolean => typeof value === "object" && value !== null && mirrorChecks.has(value);
export const isBundleCheck = (value: unknown): boolean => typeof value === "object" && value !== null && bundleChecks.has(value);
