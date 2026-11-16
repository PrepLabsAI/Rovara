// Device testing slice 2 (DEC 244): the Maestro flow content. A recipe step's `actions` (a short fixed list, contracts/device-evidence.ts) become the YAML of one Maestro flow; the executor writes
// that text to its own scratch file and runs `maestro test` on it. The recipe never holds Maestro's own syntax: there is no way to say `runScript`, `evalScript`, `openLink`, `runFlow` or
// another app's id, because nothing but the eight actions below can be written, every string is quoted (no text can end its line or start a new command), and the app id is the recipe's own,
// checked. A flow is launched from a clean state with every permission denied. Pure.
import { DEVICE_EVIDENCE_APP_ID, DeviceEvidenceActionSchema, type DeviceEvidenceAction } from "@agentx/contracts";

/** A string as a double-quoted YAML scalar: JSON's quoting, with the three Unicode line breaks written as escapes (YAML 1.1 reads them as line ends). */
function quoted(value: string): string {
  return JSON.stringify(value).replace(/[\u0085\u2028\u2029]/gu, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
/** Maestro matches `text` and `id` as regular expressions: every character that means something there is escaped, so the recipe's words are matched as written. */
function literal(value: string): string {
  return quoted(value.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&"));
}

/** The Maestro commands (YAML lines, already indented as list items) of one action. Throws on anything that is not one of the eight actions. */
function commandOf(action: DeviceEvidenceAction): string[] {
  switch (action.do) {
    case "tap_text": return ["- tapOn:", `    text: ${literal(action.text)}`];
    case "tap_id": return ["- tapOn:", `    id: ${literal(action.id)}`];
    case "input": return [`- inputText: ${quoted(action.text)}`];
    case "wait_text": return ["- assertVisible:", `    text: ${literal(action.text)}`];
    case "wait_id": return ["- assertVisible:", `    id: ${literal(action.id)}`];
    case "scroll": return ["- scroll"];
    case "back": return ["- back"];
    case "hide_keyboard": return ["- hideKeyboard"];
  }
}

const header = (appId: string): string => {
  if (!DEVICE_EVIDENCE_APP_ID.test(appId) || appId.length > 200) throw new Error("the application id is not valid");
  return `appId: ${appId}\n---\n`;
};
/** Starts the app from a clean state: its data cleared, every permission denied (Maestro grants them all unless told not to). */
const LAUNCH = ["- launchApp:", "    clearState: true", "    stopApp: true", "    permissions:", "      all: deny"];

/** The flow that starts the app from a clean state and does nothing else. */
export function maestroLaunchFlow(appId: string): string {
  return `${header(appId)}${LAUNCH.join("\n")}\n`;
}
/** The flow of one step: its actions, in order. Every action is checked here again (this is the one place that writes Maestro), and a step with none has no flow (null). */
export function maestroStepFlow(appId: string, actions: readonly unknown[]): string | null {
  if (actions.length === 0) return null;
  const lines = actions.flatMap((action) => commandOf(DeviceEvidenceActionSchema.parse(action)));
  return `${header(appId)}${lines.join("\n")}\n`;
}
