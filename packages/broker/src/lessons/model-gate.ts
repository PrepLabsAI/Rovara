// The entry-point defence: while the install's lessons switch is off (or cannot be read) NO learning model call is made, whatever path asked. `resolveLearning` already caps the mode every pipeline
// path obeys (policy.ts `OFF_SWITCH_CAP`); this wrapper is the second lock, on the model itself, so a path that skips `resolveLearning` (a future caller, a stale queue message) still cannot spend. The refusal is raised
// BEFORE the wrapped model is touched: no plan, no hold, no key, no provider call. Fixed words only.
import { LearningRefusal } from "./pause.js";
import { learnedLessonsSwitchOn } from "./policy.js";
import type { PipelineModel } from "./ports.js";

export const LESSONS_SWITCHED_OFF = "Lessons are switched off for this install, so no learning call is made.";

/** The model, refusing every call while `enabled()` is not exactly true (a throwing `enabled` refuses too). `enabled` defaults to the install's lessons switch. */
export function gatedByLessonsSwitch(model: PipelineModel, enabled: () => boolean = learnedLessonsSwitchOn): PipelineModel {
  const on = (): boolean => { try { return enabled() === true; } catch { return false; } };
  return {
    ...(model.quote === undefined ? {} : {
      quote: async (request) => (on() ? model.quote!(request) : { ok: false as const, code: "no_provider" as const }),
    }),
    complete: async (request) => {
      if (!on()) throw new LearningRefusal("no_provider", LESSONS_SWITCHED_OFF);
      return model.complete(request);
    },
  };
}
