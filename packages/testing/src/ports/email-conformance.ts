// The conformance suite every `email` adapter must pass: the in-memory fake, and Cloud's email-service adapter later (over a fake transport).
import { describe, expect, it } from "vitest";
import { EMAIL_SUBJECT_MAX, EmailError, type EmailMessage, type EmailSender } from "@agentx/contracts";

export interface EmailUnderTest {
  sender: EmailSender;
  /** What the transport took so far, in order. */
  sent: () => EmailMessage[] | Promise<EmailMessage[]>;
  /** Makes the transport fail until called with false. */
  setDown: (down: boolean) => void;
  dispose?: () => Promise<void>;
}

export interface EmailHarness {
  create(): Promise<EmailUnderTest>;
}

const message = (extra: Partial<EmailMessage> = {}): EmailMessage => ({
  companyId: "org_00000000000000000000", purpose: "attention", to: "dev@example.test", subject: "2 tasks need you", text: "Open https://rovara.example.test/app to see them.", ...extra,
});

export function runEmailConformance(name: string, harness: EmailHarness): void {
  async function withSender<T>(body: (under: EmailUnderTest) => Promise<T>): Promise<T> {
    const under = await harness.create();
    try { return await body(under); } finally { await under.dispose?.(); }
  }

  describe(`email conformance: ${name}`, () => {
    it("says it can send", () => withSender(async ({ sender }) => {
      expect(sender.capabilities.available).toBe(true);
    }));

    it("sends one message to one address with the subject and text as given", () => withSender(async ({ sender, sent }) => {
      await sender.send(message());
      const taken = await sent();
      expect(taken).toHaveLength(1);
      expect(taken[0]).toMatchObject({ to: "dev@example.test", subject: "2 tasks need you", text: "Open https://rovara.example.test/app to see them." });
    }));

    it("sends the HTML form only when it can, and the text always", () => withSender(async ({ sender, sent }) => {
      await sender.send(message({ html: "<p>Open the app.</p>" }));
      const [taken] = await sent();
      expect(taken?.text).toBe("Open https://rovara.example.test/app to see them.");
      if (sender.capabilities.html) expect(taken?.html).toBe("<p>Open the app.</p>");
      else expect(taken?.html).toBeUndefined();
    }));

    it("refuses a recipient that is not one plain address, never retried", () => withSender(async ({ sender, sent }) => {
      for (const to of ["", "not-an-address", "a@example.test, b@example.test", "Dev <dev@example.test>", "a@example.test;b@example.test", "dev@example.test\r\nBcc: x@example.test", "dev\u0001@example.test", "dev@example.test\u007f"]) {
        const failure = await sender.send(message({ to })).catch((error: unknown) => error);
        expect(failure, to).toBeInstanceOf(EmailError);
        expect((failure as EmailError).code).toBe("refused");
        expect((failure as EmailError).retryable).toBe(false);
      }
      expect(await sent()).toHaveLength(0);
    }));

    it("refuses a subject that is not one short line, an empty text and a link that is not plain https", () => withSender(async ({ sender, sent }) => {
      for (const extra of [
        { subject: "Hello\r\nBcc: x@example.test" }, { subject: "Hello\rBcc: x@example.test" }, { subject: "Hello\nBcc: x@example.test" }, { unsubscribeUrl: "https://rovara.example.test/stop\r\nBcc: x@example.test" }, { subject: `a${String.fromCharCode(0x2028)}b` }, { subject: "" }, { subject: "x".repeat(EMAIL_SUBJECT_MAX + 1) },
        { text: "" }, { unsubscribeUrl: "http://rovara.example.test/stop" }, { unsubscribeUrl: "https://user:pw@rovara.example.test/stop" }, { unsubscribeUrl: "javascript:alert(1)" },
        { purpose: "Not A Word" },
      ] as const) {
        await expect(sender.send(message(extra)), JSON.stringify(extra)).rejects.toMatchObject({ name: "EmailError", code: "refused" });
      }
      expect(await sent()).toHaveLength(0);
    }));

    it("says a refusal or a failure in fixed words: never the address or the subject", () => withSender(async ({ sender, setDown }) => {
      const secretish = message({ to: "private.person@example.test", subject: "About Project Nightjar" });
      setDown(true);
      const down: unknown = await sender.send(secretish).catch((error: unknown) => error);
      const refused: unknown = await sender.send({ ...secretish, to: "private.person@example" }).catch((error: unknown) => error);
      for (const failure of [down, refused]) {
        expect(failure).toBeInstanceOf(EmailError);
        if (!(failure instanceof EmailError)) continue;
        expect(failure.message).not.toContain("private.person");
        expect(failure.message).not.toContain("Nightjar");
      }
    }));

    it("throws a retryable `unavailable` when the transport is down, and sends once it is back", () => withSender(async ({ sender, setDown, sent }) => {
      setDown(true);
      const failure = await sender.send(message()).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(EmailError);
      expect((failure as EmailError).code).toBe("unavailable");
      expect((failure as EmailError).retryable).toBe(true);
      setDown(false);
      await sender.send(message());
      expect(await sent()).toHaveLength(1);
    }));

    it("gives up with `unavailable` when the deadline has passed", () => withSender(async ({ sender, sent }) => {
      await expect(sender.send(message({ deadline: Date.now() - 1 }))).rejects.toMatchObject({ name: "EmailError", code: "unavailable" });
      expect(await sent()).toHaveLength(0);
    }));
  });
}
