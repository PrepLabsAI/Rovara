// The published pi-memory extension ships JavaScript only (dist/index.js, its Pi manifest entry); this is the one export the worker uses (pi-memory.ts).
declare module "@samfp/pi-memory/dist/index.js" {
  import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
  /** The extension's factory: registers its event handlers and its memory_* tools on the API it is given. */
  const piMemory: (pi: ExtensionAPI) => void;
  export default piMemory;
}
