/** A credential is missing, malformed or refused. The message is for an administrator and never holds a secret. */
export class CredentialUnavailable extends Error {
  constructor(message: string) { super(message); this.name = "CredentialUnavailable"; }
}
