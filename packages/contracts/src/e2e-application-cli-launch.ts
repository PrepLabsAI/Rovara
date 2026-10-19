import { z } from "zod";
import { E2EApplicationCliHostDescriptorSchema } from "./e2e-application-execution.js";
import { E2ETargetSchema } from "./e2e.js";

/** The exact private launch sidecar consumed by the installed application CLI host. */
export const E2EApplicationCliLaunchContextSchema = z.object({
  schemaVersion: z.literal("e2e-application-cli-launch/v1"),
  launchId: z.string().uuid(),
  shardId: z.string().min(1).max(120),
  compiledInventoryDigest: z.string().regex(/^[a-f0-9]{64}$/),
  groupCompiledInventoryDigest: z.string().regex(/^[a-f0-9]{64}$/),
  bindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
  roundId: z.string().uuid(),
  runId: z.string().uuid(),
  cliHost: z.object({ profileId: z.string().min(1).max(120), descriptor: E2EApplicationCliHostDescriptorSchema }).strict(),
  selectedTarget: E2ETargetSchema,
  transportId: z.string().min(1).max(256),
  transportCorrelationId: z.string().uuid(),
  deadlineAt: z.string().datetime({ offset: true }),
}).strict();

export type E2EApplicationCliLaunchContext = Readonly<z.infer<typeof E2EApplicationCliLaunchContextSchema>>;
