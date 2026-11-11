import { nativeConnectionCheck, nativeConnectorType } from "./runtime.js";
import { GRAFANA_SPEC } from "./grafana.js";

/** Grafana, read natively in the broker through an org connection's service account token, over the endpoint guard. */
export const grafanaConnectorType = nativeConnectorType(GRAFANA_SPEC);

/** The org connection check for a Grafana connection (`OrgConnectionStoreInput.checks.grafana`). */
export const grafanaConnectionCheck = nativeConnectionCheck(GRAFANA_SPEC, "grafana");
