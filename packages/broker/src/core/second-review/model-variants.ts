// Variants of an OpenRouter model that are not ordinary chat models.
import type { ModelIdentifier } from "@agentx/contracts";

/** A free variant of an OpenRouter model: the provider may train on what it is sent. */
export const isFreeVariant = (model: ModelIdentifier): boolean => model.provider.toLowerCase() === "openrouter" && /:free$/iu.test(model.modelId);

/** A `:batch` variant of an OpenRouter model: the id the Batch API uses (half price, answered within a day), not one for chat calls. */
export const isBatchVariant = (model: ModelIdentifier): boolean => model.provider.toLowerCase() === "openrouter" && /:batch$/iu.test(model.modelId);
