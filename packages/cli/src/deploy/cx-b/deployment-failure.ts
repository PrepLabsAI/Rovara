import type { Stack, StackEvent } from "@aws-sdk/client-cloudformation";

/** The oldest failed resource from this operation that was not cancelled, then the stack reason. */
export function deploymentFailureReason(ours: StackEvent[], stack: Stack): string {
  const rootCause = ours
    .filter((event) => (event.ResourceStatus ?? "").endsWith("_FAILED") && event.ResourceStatusReason !== undefined)
    .filter((event) => !/cancelled/i.test(event.ResourceStatusReason ?? ""))
    .at(-1);
  return rootCause?.ResourceStatusReason ?? stack.StackStatusReason ?? "no failed resource reported a reason";
}
