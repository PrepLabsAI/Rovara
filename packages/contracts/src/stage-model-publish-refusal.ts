// "How we work": one stage's refusal as the page shows it. A refused publish, confirm, rollback or pointer write is lane C's `ProcessModelRefusal` (409 `{code, stage, fixHref}`); the page maps it to this shape.
import type { StageId, StageModelRefusalCode } from "./stage-model-shared.js";

export interface StageRefusal {
  code: StageModelRefusalCode;
  stage: StageId;
  /** A same-origin page that helps fix it; only ever one of the app paths the server knows. */
  fixHref?: string;
}
