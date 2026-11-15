// TE-F2 part B (M2, release 0.5.19): the port the helper's 443 and 80 listeners call to record WHICH model host a client dialed when it ignored its redirect (te-f1 design 3.2, 3.4; DECISIONS 163b D3). The block is F1-b's: it points
// every model host at the helper by name (`--add-host`), so a client that ignores its base URL connects to the helper on 443 (TLS) or 80 (plain HTTP). Reading the NAME out of the first bytes (the TLS hello's server name, the
// Host header) is F1-b's recorder module (`model-helper-recorder.ts`); until that is pushed this lane owns THIS port, a placeholder that records the connection with no name, and a test double that reads names (tests/support).
//
// What the port may return: a host as plain text, or `undefined` when no name could be read. The helper puts a returned name through the strict host checker again before it writes it to the ledger, and a connection with no
// readable name is still an escape ("unreadable"): the round is "not run", never a pass. The port gets the first bytes only (at most 16 KiB) and never gets, keeps or forwards a body.
export const MODEL_ESCAPE_PORTS = [443, 80] as const;
export type ModelEscapePort = (typeof MODEL_ESCAPE_PORTS)[number];
export const MODEL_ESCAPE_READ_MAX_BYTES = 16 * 1024;
export const MODEL_ESCAPE_READ_TIMEOUT_MS = 3_000;

export interface ModelHostObservation {
  /** The server name the client asked for, as text; undefined when none could be read. Untrusted: the helper checks it again. */
  readonly host: string | undefined;
}

export interface ModelHostRecorderPort {
  /** One accepted connection's first bytes on port 443 (a TLS hello) or 80 (an HTTP request). Never throws for bytes it cannot read: that is `{ host: undefined }`. */
  observe(connection: { readonly port: ModelEscapePort; readonly firstBytes: Uint8Array }): ModelHostObservation;
}

/** The recorder the program uses until F1-b's reads names: it records that a client connected and no name. The evidence says "not run: a client ignored the redirect (host unreadable)". */
export const UNNAMED_ESCAPE_RECORDER: ModelHostRecorderPort = {
  observe: () => ({ host: undefined }),
};
