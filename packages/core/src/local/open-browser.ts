// Lane L9-wire: opening a review page in the owner's browser FROM THE SERVER PROCESS. A page address carries the owner's page session, and whoever holds it can approve (L8). So the
// address is never sent to a client: an API route asks the server to open it and answers `{ opened: true }` only. (`pages.link` stays inside this process.)
import { execFile } from "node:child_process";

export type BrowserOpener = (url: string) => Promise<void>;

/** The system browser: `open` on macOS, `xdg-open` on Linux, `start` on Windows. The address is one argument and never goes through a shell. */
export const openInSystemBrowser: BrowserOpener = (url) =>
  new Promise((resolve, reject) => {
    const [program, args]: [string, string[]] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
    execFile(program, args, { timeout: 10_000, windowsHide: true }, (error) => (error === null ? resolve() : reject(new Error("the browser could not be opened"))));
  });
