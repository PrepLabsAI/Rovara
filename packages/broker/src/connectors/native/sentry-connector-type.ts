import { nativeConnectionCheck, nativeConnectorType } from "./runtime.js";
import { SENTRY_SPEC } from "./sentry.js";

/** Sentry, read natively in the broker through an org connection's auth token; one scope per project. */
export const sentryConnectorType = nativeConnectorType(SENTRY_SPEC);

/** The org connection check for a Sentry connection (`OrgConnectionStoreInput.checks.sentry`). */
export const sentryConnectionCheck = nativeConnectionCheck(SENTRY_SPEC, "sentry");
