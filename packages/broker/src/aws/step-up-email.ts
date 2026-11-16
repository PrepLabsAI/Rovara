// Lane ID part 2 on AWS (hosted wiring (a)): the step-up's one-time code goes out through Amazon SES (API v2), from the one verified identity the install names (the
// `StepUpEmailSender` stack parameter, passed as STEP_UP_EMAIL_FROM). The function's role may send only as that identity (infra/lib/developer-signin.ts).
//
// The message is never logged and never repeated in an error: a failed send throws a fixed error (the step-up then counts it as not sent, and fails closed). The sender
// address is checked once, when the sender is built; an unusable one builds no sender, so the email factor stays off and a step-up is refused in fixed words.
import { SendEmailCommand, type SESv2Client } from "@aws-sdk/client-sesv2";
import type { StepUpEmailSender } from "../developer/step-up.js";

/** One plain address: no display name, no spaces, one `@`, a dot in the domain. What SES calls an email identity. */
const SENDER = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/u;
const SENDER_MAX = 254;

export class StepUpEmailNotSent extends Error {
  constructor() {
    super("the step-up email was not sent");
    this.name = "StepUpEmailNotSent";
  }
}

/** The configured sender, or undefined for an empty or unusable one (the email factor is then off). */
export function stepUpEmailSenderAddress(value: string | undefined): string | undefined {
  if (value === undefined || value === "" || value.length > SENDER_MAX || !SENDER.test(value)) return undefined;
  return value;
}

/** The SES sender of the step-up code. `from` must be what `stepUpEmailSenderAddress` returned. */
export function sesStepUpEmailSender(options: { ses: Pick<SESv2Client, "send">; from: string }): StepUpEmailSender {
  const from = stepUpEmailSenderAddress(options.from);
  if (from === undefined) throw new Error("the step-up email sender is not one plain address");
  return {
    async send(message) {
      try {
        await options.ses.send(new SendEmailCommand({
          FromEmailAddress: from,
          Destination: { ToAddresses: [message.to] },
          Content: { Simple: { Subject: { Data: message.subject, Charset: "UTF-8" }, Body: { Text: { Data: message.text, Charset: "UTF-8" } } } },
        }));
      } catch {
        // The SDK's error can quote the request (the address, the code): it is dropped here.
        throw new StepUpEmailNotSent();
      }
    },
  };
}
