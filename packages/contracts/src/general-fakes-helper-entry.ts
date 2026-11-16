// The NARROW entry of the hosted fake-helper program (`@agentx/contracts/general-fakes-helper`, like `model-helper`): the helper has no outbound socket anywhere in its import graph, and the package's main entry re-exports
// modules that call `fetch`, so the program imports only these names, all of them pure fake and set code. A test walks the program's import graph from this file and fails if any module in it can open a connection.
export { answerOpenApiFake, type OpenApiFake } from "./openapi-fake.js";
export {
  GENERAL_FAKE_ANSWER_HEADER, GENERAL_FAKE_ANSWER_LABEL, GENERAL_FAKE_CANNOT_ANSWER_BODY, GENERAL_FAKES_HELPER_PORT, GENERAL_FAKES_LEDGER_DIR, GENERAL_FAKES_SET_PATH, GENERAL_FAKES_SUMMARY_PATH,
  GENERAL_FAKES_SET_MAX_BYTES, GENERAL_FAKES_SUMMARY_MAX_COUNT, UNTRUSTED_GENERAL_FAKES_SUMMARY, parseGeneralFakesSetBytes, parseGeneralFakesSummaryText,
  GeneralFakesSummarySchema, type GeneralFakeServiceFake, type GeneralFakesSummary, type TrustedGeneralFakesSummary,
} from "./general-fakes-set.js";
