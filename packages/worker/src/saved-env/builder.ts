import { SAVED_ENV_BUILDER_DIGEST } from "@agentx/contracts";

/** Only the reviewed rootless bytes (including a byte-identical mirror); absence never permits buildx's default image. */
export function pinnedSavedEnvBuilder(image: string | undefined): image is string {
  return typeof image === "string" && /^[a-z0-9][a-z0-9._/:-]{0,200}@sha256:[a-f0-9]{64}$/u.test(image) && image.endsWith(`@${SAVED_ENV_BUILDER_DIGEST}`);
}
