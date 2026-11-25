// Lane L12: the core engine's own /v1/app/* routes on the broker's HTTP API (sessions, decision cards, how we work, script tokens, person erase).
//
// The developer API (aws/developer-routes.ts, `routeAppRequest`) refuses a method and path with no row in the route table (dev-route-scopes.ts, APP_ROUTES) before anyone is
// authenticated, verifies the developer token itself (no API Gateway authorizer, as /v1/dev/*), checks the row's scope, and only then hands the signed-in caller here. This entry:
//   - maps the broker's signed-in caller to the principal the core knows (`deployedCallerOf`: the company and role from LIVE membership, never a token claim; the sign-in method and client only as the
//     verified token states them). No mapping, or a mapping that throws, is the sign-in refusal; nothing is read for the core.
//   - hands a person erase (`POST /v1/app/people/<id>/erase`) to the person-erase route (#687), and every other /v1/app path to the core host's dev routes, which check the company,
//     the person's level, grant or role on every act (DEC 254zzz73: no step-up).
//   - answers anything the core's handlers throw (a runtime or registry that cannot be built) with fixed words and a log line naming only the error's kind.
// While the core switch is off the deployment builds no entry at all, so the developer API answers every /v1/app/* path "route not found" and reads nothing.
import { MEMBERSHIP_READ_FAILED_WORDS } from "../core/membership-read.js";
import type { DeployedCaller, SlackThreadAnswer, SlackThreadAnswerInput } from "../core-host/dev-routes.js";
import type { PersonEraseCaller } from "../core-host/person-erase-route.js";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import type { CoreEntryCaller } from "./engine-boundary.js";

/** The prefix of every path this entry serves. */
export const CORE_APP_PREFIX = "/v1/app/";
const PERSON_ERASE = /^\/v1\/app\/people\/[^/]+\/erase$/u;

export const CORE_APP_SIGN_IN_AGAIN = "Sign in again.";
export const CORE_APP_UNAVAILABLE = "The core engine is not available on this install just now; try again shortly.";

/** The core's /v1/app/* handlers for a signed-in developer, as the deployment composes them. `undefined`: the core does not serve this path. */
export interface CoreAppEntry {
  route(request: BrokerRequest, caller: CoreEntryCaller): Promise<BrokerResponse | undefined>;
  /**
   * Lead 4 J2: the smart Just answer for a verified Slack thread, in process (the Slack service route `POST /v1/service/answers`, aws/slack-answers.ts). Not an HTTP route: nothing a caller sends can reach it.
   * `undefined`: the core does not serve answers for this company.
   */
  answerForSlackThread?(input: SlackThreadAnswerInput): Promise<SlackThreadAnswer | undefined>;
}

export interface CoreAppEntryOptions {
  /** The core host's dev routes (`createCoreDevRoutes`). */
  routes: { route(request: BrokerRequest, caller: DeployedCaller): Promise<BrokerResponse | undefined>; answerForSlackThread?: CoreAppEntry["answerForSlackThread"] };
  /** The person-erase route (`createPersonEraseRoute`, through the root's `personErase`). */
  personErase: { route(request: BrokerRequest, caller: PersonEraseCaller): Promise<BrokerResponse | undefined> };
  /** The deployment's identity mapping: the company and role from membership. Undefined: not a member of any company (the sign-in refusal). */
  deployedCallerOf(caller: CoreEntryCaller): Promise<DeployedCaller | undefined>;
  log: (entry: Record<string, unknown>) => void;
}

const answer = (statusCode: number, code: string, message: string): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify({ error: { code, message } }) });

export function coreAppEntryFrom(options: CoreAppEntryOptions): CoreAppEntry {
  const answerForSlackThread = options.routes.answerForSlackThread;
  return {
    ...(answerForSlackThread === undefined ? {} : { answerForSlackThread: (input: SlackThreadAnswerInput) => answerForSlackThread.call(options.routes, input) }),
    async route(request, caller) {
      const path = request.path.split("?")[0] ?? "";
      if (!path.startsWith(CORE_APP_PREFIX)) return undefined;
      let deployed: DeployedCaller | undefined;
      // A membership read that FAILED is the retryable 503 (membership-read.ts); only a read that says "no membership" is the sign-in refusal.
      try { deployed = await options.deployedCallerOf(caller); } catch { return answer(503, "RUNTIME_UNAVAILABLE", MEMBERSHIP_READ_FAILED_WORDS); }
      if (deployed === undefined || deployed === null) return answer(401, "UNAUTHENTICATED", CORE_APP_SIGN_IN_AGAIN);
      try {
        return PERSON_ERASE.test(path) ? await options.personErase.route(request, deployed) : await options.routes.route(request, deployed);
      } catch (error) {
        options.log({ event: "core_engine.app_route_unavailable", error: error instanceof Error ? error.name : "unknown" });
        return answer(503, "RUNTIME_UNAVAILABLE", CORE_APP_UNAVAILABLE);
      }
    },
  };
}
