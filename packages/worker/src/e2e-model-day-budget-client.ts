import { randomUUID } from "node:crypto";
import {
  E2E_MODEL_BUDGET_MAX_CALL_TOKENS,
  E2E_MODEL_BUDGET_SCHEMA_VERSION,
  E2EModelDayBudgetResponseSchema,
  type E2EModelDayBudgetRequest,
  type E2EModelDayBudgetResponse,
} from "@agentx/contracts";
import type { E2EDayLimits } from "@agentx/model-runtime";

/**
 * The worker's side of the project's day budget (M1.4 Task 4.3a, Ruling DB-8). The worker has no DynamoDB access, so each reserve, settle and release is a callback to the
 * broker (`e2e-model-budget`), which keeps the reservation rows, derives the day caps from the route itself and takes the project from the operation. Nothing the worker sends
 * names a project, a day or a cap.
 *
 * - `reserve` is one call, no retry. A broker answer of `exhausted` is no reservation (the route then refuses the call with `budget`); a failure to ask throws, which the route
 *   also turns into `budget`, so a reserve that cannot be recorded never reaches the provider.
 * - `settle` and `release` have 5 seconds and one retry. The broker treats a repeated one as a no-op (the reservation id is the key), so a retry can never charge twice. When
 *   both attempts fail the error is thrown and the reservation is left open: the call stays charged (fail closed) until the broker's row expires.
 * The error text carries nothing from the broker's answer.
 */

export const E2E_MODEL_BUDGET_TIMEOUT_MS = 5_000;

export interface E2EModelDayBudgetClientOptions {
  /** Sends one budget request to the broker and returns its answer. It receives a signal that aborts at the timeout. */
  post(body: E2EModelDayBudgetRequest, signal: AbortSignal): Promise<unknown>;
  /** The group run the reservations belong to. */
  groupRunId: string;
  newReservationId?: () => string;
  /** Per attempt. Default 5000. */
  timeoutMs?: number;
}

class BudgetUnavailable extends Error {
  constructor() { super("the project's daily model budget could not be reached"); this.name = "E2EModelBudgetUnavailable"; }
}

/** One reservation against the project's day, as the broker callback keeps it: every stage is asynchronous (an `E2EDayReservation`, which allows both). */
export interface E2EModelDayBudgetReservation {
  settle(actualInputTokens: number): Promise<void>;
  release(): Promise<void>;
}
/** The day budget over the broker callback (an `E2EDayBudget` whose `reserve` is always asynchronous). */
export interface E2EModelDayBudgetClient {
  reserve(inputTokens: number, limits: E2EDayLimits): Promise<E2EModelDayBudgetReservation | null>;
}

export function createE2EModelDayBudgetClient(options: E2EModelDayBudgetClientOptions): E2EModelDayBudgetClient {
  const timeoutMs = options.timeoutMs ?? E2E_MODEL_BUDGET_TIMEOUT_MS;
  const newReservationId = options.newReservationId ?? randomUUID;

  /** One attempt, bounded: aborted and abandoned at the timeout, whatever the transport does. */
  async function attempt(body: E2EModelDayBudgetRequest, reservationId: string): Promise<E2EModelDayBudgetResponse> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const answer = await Promise.race([
        options.post(body, controller.signal),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new BudgetUnavailable()); }, timeoutMs); }),
      ]);
      const parsed = E2EModelDayBudgetResponseSchema.safeParse(answer);
      if (!parsed.success || parsed.data.reservationId !== reservationId) throw new BudgetUnavailable();
      return parsed.data;
    } catch (error) {
      throw error instanceof BudgetUnavailable ? error : new BudgetUnavailable();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** `settle` and `release`: a second attempt with the same request, which the broker treats as a no-op if the first got through. */
  async function withRetry(body: E2EModelDayBudgetRequest, reservationId: string, expected: E2EModelDayBudgetResponse["status"]): Promise<void> {
    for (let tried = 1; ; tried += 1) {
      try {
        const answer = await attempt(body, reservationId);
        if (answer.status !== expected) throw new BudgetUnavailable();
        return;
      } catch (error) {
        if (tried >= 2) throw error instanceof BudgetUnavailable ? error : new BudgetUnavailable();
      }
    }
  }

  return {
    async reserve(inputTokens: number, _limits: E2EDayLimits): Promise<E2EModelDayBudgetReservation | null> {
      void _limits;
      if (!Number.isSafeInteger(inputTokens) || inputTokens < 1 || inputTokens > E2E_MODEL_BUDGET_MAX_CALL_TOKENS) throw new BudgetUnavailable();
      const reservationId = newReservationId();
      // Fail closed: a reserve that times out after the broker wrote its row stays charged until the day's end (the worker cannot know to release it); an unknown is never a free call.
      const answer = await attempt({ schemaVersion: E2E_MODEL_BUDGET_SCHEMA_VERSION, stage: "reserve", reservationId, groupRunId: options.groupRunId, inputTokens }, reservationId);
      if (answer.status === "exhausted") return null;
      if (answer.status !== "reserved") throw new BudgetUnavailable();
      let done = false;
      return {
        async settle(actualInputTokens: number): Promise<void> {
          if (done) return;
          if (!Number.isFinite(actualInputTokens) || actualInputTokens < 1) throw new BudgetUnavailable();
          // The broker's bound for one settle; a call charged more than a receipt can show is still settled at the bound.
          const actual = Math.min(Math.trunc(actualInputTokens), E2E_MODEL_BUDGET_MAX_CALL_TOKENS);
          await withRetry({ schemaVersion: E2E_MODEL_BUDGET_SCHEMA_VERSION, stage: "settle", reservationId, actualInputTokens: actual }, reservationId, "settled");
          done = true;
        },
        async release(): Promise<void> {
          if (done) return;
          await withRetry({ schemaVersion: E2E_MODEL_BUDGET_SCHEMA_VERSION, stage: "release", reservationId }, reservationId, "released");
          done = true;
        },
      };
    },
  };
}
