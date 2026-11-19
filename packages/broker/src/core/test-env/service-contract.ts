// The generic contract finder (TE-G6, PR 589) lives in @agentx/contracts so the worker can build general fakes from it (DEC 234); this path keeps its broker callers unchanged.
export { CONTRACT_LIMITS, findServiceContract, isServiceContract, shapeFromSchema, shapeFromValue } from "@agentx/contracts";
export type { AdapterRead, AnswerShape, ContractAdapter, ContractFile, ContractInputResult, ContractReason, ContractResult, ContractSource, ContractSourceKind, ServiceContract } from "@agentx/contracts";
