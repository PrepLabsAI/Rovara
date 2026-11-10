// Lessons reach the agent: the install switch. Approved lessons are loaded into an agent's prompt, and learning makes model calls, only where this is on. The library's own form of the switch
// is exactly "1" in the environment variable `ROVARA_LESSONS` (unset, empty, "true" or " 1" are off), so a host that never chose never starts spending on learning by itself. A laptop
// install (`rovara up`) answers its own form of the question: lessons are on unless `ROVARA_LESSONS` is exactly "0" (see `localLessonsEnabled`). Leaf module (no broker imports).
import { liveInteractionFlagOn } from "@agentx/contracts";

/** The environment variable of the switch. */
export const LESSONS_SWITCH_VARIABLE = "ROVARA_LESSONS";

/** Whether approved lessons may be loaded into an agent in this install. Anything but exactly "1" is off. */
export const learnedLessonsEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => liveInteractionFlagOn(env[LESSONS_SWITCH_VARIABLE]);

/** Whether lessons are on for `rovara up`: on, in Suggest mode (every lesson waits for the owner's approval), unless `ROVARA_LESSONS` is exactly "0". The switch is process-wide: it is not per project. */
export const localLessonsEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env[LESSONS_SWITCH_VARIABLE] !== "0";

/** The same switch, failing closed: a read that throws (an unreadable environment) is off. Every model path asks this form. */
export const learnedLessonsOn = (env: NodeJS.ProcessEnv = process.env): boolean => { try { return learnedLessonsEnabled(env); } catch { return false; } };
