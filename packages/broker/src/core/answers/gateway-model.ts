// The hosted model seam (lead 4, J1; DEC 254z-amend2): hosted answers call the gateway's "answers" purpose through this interface. The gateway side (a TC-1 token with a reserved step accepted only on its
// own path, the company's own key, its own meter row folded into the company cap, its own monthly limit) is Cloud lane L4-E. Until it lands the hosted wiring passes no gateway, and the service answers
// the fixed "answers are not set up here yet" outcome (never a dead button).
import { AnswerModelRefused, type AnswerModel, type AnswerModelReply, type AnswerModelSession, type AnswerModelTurn } from "./ports.js";

export type AnswersGatewayRefusal = "not_set_up" | "over_budget" | "unavailable";

/** What L4-E provides: reserve the answer's ceiling once, call the model inside that reservation, and settle (or release) it. Every method rejects with `AnswersGatewayError` for a refusal. */
export interface AnswersGateway {
  /** Whether the company has the answers purpose and a connected key (checked before anything is counted). */
  available(input: { companyId: string }): Promise<boolean>;
  reserve(input: { companyId: string; project: string; personId: string; idempotencyKey: string; ceilingCents: number }): Promise<{ reservationId: string }>;
  call(input: { reservationId: string; system: string; transcript: string; maxOutputTokens: number; signal: AbortSignal; remainingCents: number }): Promise<{ text: string; model: string; tokens?: { input: number; output: number } | undefined; costCents?: number | undefined }>;
  /** Settles what was spent (the unused part of the reservation is released). `costCents` absent: the call could not be priced and the gateway settles at the reserved ceiling. */
  settle(input: { reservationId: string; costCents?: number | undefined }): Promise<void>;
}

export class AnswersGatewayError extends Error {
  constructor(readonly reason: AnswersGatewayRefusal) {
    super(reason);
    this.name = "AnswersGatewayError";
  }
}

const refusalOf = (error: unknown): AnswerModelRefused => new AnswerModelRefused(error instanceof AnswersGatewayError ? error.reason : "unavailable");

/** The model of one company's answers through the gateway. The dollar ceiling is reserved once when an answer opens it, every turn is a call inside that reservation, and the reservation is settled once. */
export function createGatewayAnswerModel(gateway: AnswersGateway, companyId: string): AnswerModel {
  return {
    async available() {
      try { return await gateway.available({ companyId }); } catch { return false; }
    },
    async open(input): Promise<AnswerModelSession> {
      // The model is made for one company: a request for another company's answer is never reserved.
      if (input.companyId !== companyId) throw new AnswerModelRefused("unavailable");
      let reservation: { reservationId: string };
      try {
        reservation = await gateway.reserve({ companyId, project: input.project, personId: input.personId, idempotencyKey: `answer:${input.answerId}`, ceilingCents: input.ceilingCents });
      } catch (error) { throw refusalOf(error); }
      let settled = false;
      return {
        async complete(turn: AnswerModelTurn): Promise<AnswerModelReply> {
          try {
            return await gateway.call({ reservationId: reservation.reservationId, system: turn.system, transcript: turn.transcript, maxOutputTokens: turn.maxOutputTokens, signal: turn.signal, remainingCents: turn.remainingCents });
          } catch (error) { throw refusalOf(error); }
        },
        async finish(spent) {
          if (settled) return;
          settled = true;
          await gateway.settle({ reservationId: reservation.reservationId, ...(spent.costCents === undefined ? {} : { costCents: spent.costCents }) });
        },
      };
    },
  };
}
