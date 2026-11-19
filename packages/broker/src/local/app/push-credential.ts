// Lane L10 (review H1): what a worker is sent for the credential the code-host adapter gave (`CodeHost.issueGitCredential`). The adapter applies its own rules (registered repositories only, a
// fine-grained token unless the owner opted in, push permission checked: lane L11). With the personal-token adapter the credential IS the owner's fine-grained token, handed out for 50 minutes by Rovara's reckoning (the token itself lives as long
// as the owner made it). It must be usable now (expiring within the hour, a key only for a service identity) and have a wire shape the worker takes. A broker-side git relay (the broker pushes, the worker never holds a push credential) is the later fix.
import { agentXError, workerGitCredentialUsable, type CodeHost, type GitCredential } from "@agentx/contracts";
import type { RepositoryCredential } from "../../repository-access.js";

/** What a worker is sent for a credential the adapter gave: the legacy wire shapes only (`{token}`, `{username, password}` as a token) and an ssh key; a helper has no wire shape. */
export function workerCredentialOf(credential: GitCredential): RepositoryCredential {
  switch (credential.kind) {
    case "token": return { token: credential.token };
    case "basic": return { token: credential.password };
    case "ssh-key": return { sshPrivateKey: credential.privateKey };
    case "helper": throw agentXError("FORBIDDEN", "this code host's credential cannot be given to a worker");
  }
}

/** The credential for a worker, or a refusal in plain words when the adapter's is expired, too long-lived or not a shape the worker takes. */
export function usableWorkerCredential(host: Pick<CodeHost, "capabilities">, issued: GitCredential, now: number = Date.now()): RepositoryCredential {
  const usable = workerGitCredentialUsable(issued, { now, actingAs: host.capabilities.perPersonCredentials ? "on-behalf-of" : "service" });
  if (!usable.ok) throw agentXError("FORBIDDEN", "the code host did not give a usable credential");
  return workerCredentialOf(usable.credential);
}
