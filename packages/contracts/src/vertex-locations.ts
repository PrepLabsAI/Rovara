// The Vertex AI locations that have a `<location>-aiplatform.googleapis.com` host. One list for the model catalog (model-catalog-rows.ts) and the default allow list
// (default-allow-domains.ts), so a location added for one is added for the other. Imports nothing (the allow list is loaded by the infra app and the worker).
/** Exact names only (never *.googleapis.com). Compared 2026-11-13 with
 * https://docs.cloud.google.com/vertex-ai/docs/general/locations and
 * https://docs.cloud.google.com/docs/security/compliance/restrict-endpoint-usage (also verifies us-west8/mTLS).
 * Retain the existing northamerica-south1 entries; that location is not verified by these lists.
 */
export const VERTEX_LOCATIONS = [
  "us", "eu", "us-central1", "us-east1", "us-east4", "us-east5", "us-south1", "us-west1", "us-west2", "us-west3", "us-west4", "northamerica-northeast1", "northamerica-northeast2", "southamerica-east1",
  "southamerica-west1", "europe-central2", "europe-north1", "europe-southwest1", "europe-west1", "europe-west2", "europe-west3", "europe-west4", "europe-west6", "europe-west8", "europe-west9", "europe-west12",
  "asia-east1", "asia-east2", "asia-northeast1", "asia-northeast2", "asia-northeast3", "asia-south1", "asia-southeast1", "asia-southeast2", "australia-southeast1", "australia-southeast2", "me-central1",
  "me-central2", "me-west1", "africa-south1", "europe-west10", "asia-south2", "northamerica-south1", "europe-north2", "us-west8",
] as const;
