// The NARROW entry of the eval stand-in helper program (`@agentx/contracts/eval-standin-helper`, like `general-fakes-helper`): the helper has no outbound socket anywhere in its import graph, and the package's main entry
// re-exports modules that call `fetch`, so the program imports only these names, all of them pure stand-in code. A test walks the program's import graph from this file and fails if any module in it can open a connection.
export {
  EVAL_STAND_IN_BODY_MAX_BYTES, EVAL_STAND_IN_LABEL, EVAL_STAND_IN_LABEL_HEADER, EVAL_STAND_IN_CLASS_HEADER, EvalAnswerBook, answerEvalStandInRequest, isEvalStandInHostName,
  type EvalStandInBookEntry, type EvalStandInCounts, type EvalStandInPlan, type EvalStandInRequest, type EvalStandInStoredAnswer,
} from "./eval-standin-engine.js";
export {
  EVAL_STAND_IN_GAP_NAMES_MAX, EVAL_STAND_IN_HTTP_PORT, EVAL_STAND_IN_LEDGER_DIR, EVAL_STAND_IN_NEW_HOSTS_MAX, EVAL_STAND_IN_RUN_DIR, EVAL_STAND_IN_SET_MAX_BYTES, EVAL_STAND_IN_SET_PATH, EVAL_STAND_IN_SUMMARY_MAX_BYTES,
  EVAL_STAND_IN_SUMMARY_PATH, EVAL_STAND_IN_TLS_PORT, UNTRUSTED_EVAL_STAND_IN_SUMMARY, evalStandInPathName, parseEvalStandInSetBytes, parseEvalStandInSummaryText,
  type EvalStandInGapName, type EvalStandInSummary, type ParsedEvalStandInSet, type TrustedEvalStandInSummary,
} from "./eval-standin-set.js";
