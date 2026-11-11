// The `email` point: an in-memory sender for tests (the conformance suite and every test of a notice that may go by email), and Code's default, which sends nothing.
import { EmailError, emailRefusal, emailUnsubscribeHref, type EmailCapabilities, type EmailMessage, type EmailSender } from "@agentx/contracts";

export interface FakeEmailSender extends EmailSender {
  /** What was sent, oldest first, as the transport would have taken it (no HTML when the capabilities say none). */
  sent(): EmailMessage[];
  /** Tests: every send is `unavailable` while down. */
  setDown(down: boolean): void;
}

export function createFakeEmailSender(options: { capabilities?: Partial<EmailCapabilities> } = {}): FakeEmailSender {
  const capabilities: EmailCapabilities = { available: true, html: true, unsubscribeHeader: true, ...options.capabilities };
  const outbox: EmailMessage[] = [];
  let down = false;
  return {
    capabilities,
    async send(message) {
      const refusal = emailRefusal(message);
      if (refusal !== undefined) throw new EmailError("refused", refusal);
      if (!capabilities.available) throw new EmailError("unavailable", "no email sender is set up on this install");
      if (down || (message.deadline !== undefined && Date.now() > message.deadline)) throw new EmailError("unavailable", "the email could not be sent now");
      const { html, unsubscribeUrl, deadline: _deadline, ...rest } = structuredClone(message); // eslint-disable-line @typescript-eslint/no-unused-vars -- the deadline is the call's, not the message's
      outbox.push({ ...rest, ...(capabilities.html && html !== undefined ? { html } : {}), ...(capabilities.unsubscribeHeader && unsubscribeUrl !== undefined ? { unsubscribeUrl: emailUnsubscribeHref(unsubscribeUrl) ?? "" } : {}) });
    },
    sent: () => outbox.map((message) => structuredClone(message)),
    setDown(value) { down = value; },
  };
}

/**
 * Code's default `email` adapter: there is none. Every send is `unavailable` (after the same refusals any adapter makes), so a person's email choice reads as "not set up
 * on this install" and notices go through the channel adapters. A configured `email` plug-in replaces it.
 */
export function createUnavailableEmailSender(): EmailSender {
  return {
    capabilities: { available: false, html: false, unsubscribeHeader: false },
    async send(message) {
      const refusal = emailRefusal(message);
      if (refusal !== undefined) throw new EmailError("refused", refusal);
      throw new EmailError("unavailable", "no email sender is set up on this install");
    },
  };
}
