// Spec 048 FR-038: anything the user must act on that a child process prints (an AWS sign-in
// address and code) is shown on the page, not only in the log file. Only an https:// address the
// page may show, after a line that asks the user to open it, and a code of AWS's shape, are passed on.
import { isShowableLink } from "./state.js";

export interface ChildAction { url?: string; code?: string }

const OPEN_LINE = /open the following URL/i;
const CODE_PROMPT = /enter the code/i;
const URL_LINE = /^https:\/\/\S+$/;
const CODE_LINE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

export function childActionWatcher(onAction: (action: ChildAction) => void): { feed(text: string): void } {
  let partial = "";
  let wantUrl = false;
  let wantCode = false;
  const found: ChildAction = {};
  return {
    feed(text) {
      const lines = (partial + text).split(/\r?\n/);
      partial = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (line === "") continue;
        if (OPEN_LINE.test(line)) { wantUrl = true; continue; }
        if (CODE_PROMPT.test(line)) { wantCode = true; continue; }
        if (wantUrl && URL_LINE.test(line) && isShowableLink(line)) { found.url = line; wantUrl = false; onAction({ ...found }); continue; }
        if (wantCode && CODE_LINE.test(line)) { found.code = line; wantCode = false; onAction({ ...found }); continue; }
        wantUrl = false;
        wantCode = false;
      }
    },
  };
}
