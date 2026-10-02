// packages/cli/src/init/log-file.ts
// Spec 048 FR-059, FR-070 and FR-071: with the install page open, what the terminal used to show
// goes here (and to the page's technical log). Never the page's session token: the wizard hides it
// the moment the server has one.
import { chmod, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Writable } from "node:stream";
import { agentXError } from "@agentx/contracts";

export function initLogPath(home: string, env: string): string {
  return join(home, ".agentx", "logs", `init-${env}.log`);
}

export interface InitLog {
  path: string;
  write(text: string): void;
  /** Every later write replaces this value, and its URL-encoded form, with <hidden>. */
  hide(value: string): void;
  close(): Promise<void>;
}

/** The part of a `FileHandle` the log uses; a test hands in a failing one. */
export interface LogFileHandle {
  chmod(mode: number): Promise<void>;
  close(): Promise<void>;
  createWriteStream(): Writable;
}

export interface OpenInitLogOptions {
  /** Told once, in one plain line, when a write fails and the log stops. */
  onError?: (line: string) => void;
  openFile?: (path: string) => Promise<LogFileHandle>;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Opens the log before the wizard starts, so a path it cannot open is a plain CONFIG_INVALID
 * rather than an error event later. The folder and the file are its owner's only (0700 and 0600),
 * an existing looser file included. A write that fails later stops the log, says so once, and
 * never ends the install. */
export async function openInitLog(path: string, options: OpenInitLogOptions = {}): Promise<InitLog> {
  const openFile = options.openFile ?? ((file: string) => open(file, "a", 0o600));
  let handle: LogFileHandle | undefined;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700);
    handle = await openFile(path);
    await handle.chmod(0o600);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw agentXError("CONFIG_INVALID", `agentx init could not open its log file ${path} (${messageOf(error)}); check that its folder is yours and can be written, or pass --no-ui`);
  }
  const stream = handle.createWriteStream();
  let broken = false;
  stream.on("error", (error) => {
    if (broken) return;
    broken = true;
    options.onError?.(`The install log ${path} could not be written (${messageOf(error)}). The install goes on without it.`);
  });
  const hidden: string[] = [];
  return {
    path,
    write(text) {
      if (broken) return;
      let safe = text;
      for (const value of hidden) safe = safe.split(value).join("<hidden>");
      stream.write(safe);
    },
    hide(value) {
      if (value.length < 8) return;
      hidden.push(value);
      // A value in an address (the page's ?t=) may appear encoded.
      const encoded = encodeURIComponent(value);
      if (encoded !== value) hidden.push(encoded);
    },
    close: () => new Promise<void>((resolvePromise) => {
      if (broken || stream.destroyed) { resolvePromise(); return; }
      stream.once("error", () => resolvePromise());
      stream.end(() => resolvePromise());
    }),
  };
}
