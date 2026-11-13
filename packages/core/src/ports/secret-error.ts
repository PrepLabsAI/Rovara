// Owner decision 60 (item R2): the error Code's own secret readers throw. Its message is a FIXED sentence (it never quotes a path, a value or a file's
// content), so it is safe to show to the owner. Only this class is shown as it is: any other error from a `secrets` plug-in may carry text the plug-in
// did not mean to show, so callers replace it with a sentence of their own.
export class LocalSecretError extends Error {
  /** The system error code (`ELOOP`, `EACCES`), when there is one. Never the system error itself: its text quotes the path. */
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "LocalSecretError";
    if (code !== undefined) this.code = code;
  }
}
