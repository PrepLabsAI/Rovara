// packages/cli/src/init/log-file.ts
// Spec 048 FR-059, FR-070 and FR-071: with the install page open, what the terminal used to show
// goes here (and to the page's technical log). Never the page's session token: the wizard hides it
// the moment the server has one.
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export function initLogPath(home: string, env: string): string {
  return join(home, ".agentx", "logs", `init-${env}.log`);
}

export interface InitLog {
  path: string;
  write(text: string): void;
  /** Every later write replaces this value with <hidden>. */
  hide(value: string): void;
  close(): Promise<void>;
}

export async function openInitLog(path: string): Promise<InitLog> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const stream = createWriteStream(path, { flags: "a", mode: 0o600 });
  const hidden: string[] = [];
  return {
    path,
    write(text) {
      let safe = text;
      for (const value of hidden) safe = safe.split(value).join("<hidden>");
      stream.write(safe);
    },
    hide(value) {
      if (value.length >= 8) hidden.push(value);
    },
    close: () => new Promise<void>((resolvePromise) => { stream.end(() => resolvePromise()); }),
  };
}
