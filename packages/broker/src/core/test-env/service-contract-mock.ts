// The generic labelled mock config (TE-G6, PR 589) lives in @agentx/contracts beside the finder (DEC 234 general fakes); this path keeps its broker callers unchanged.
export { generateServiceMock, serviceMockConfigSchema } from "@agentx/contracts";
export type { ServiceMockConfig, ServiceMockOptions } from "@agentx/contracts";
