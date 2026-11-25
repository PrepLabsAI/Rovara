// F1 lane L1a-1: the ONE carry rule for a parameter an upgrade does not supply. Before this file the two deploy engines differed (templates engine: an omitted parameter reset to the
// template default; cdk engine and the production release: it kept its deployed value), so one install behaved differently on upgrade depending on which engine ran.
//
// The rule, for every engine and for the upgrade bundle: a parameter the upgrade does not supply KEEPS ITS DEPLOYED VALUE when the stack holds one and the release's template still
// declares it; a parameter new to the template takes the template's default; one the template no longer declares is simply not sent (CloudFormation refuses an undeclared name).
// The cdk engine gets this from the CDK CLI itself (`cdk deploy --parameters` names only the supplied keys and every other parameter is sent as UsePreviousValue; cdk-engine.ts never
// passes --no-previous-parameters), the production release script the same way; the templates engine and `upgrade --export` apply it with `carriedParameterNames`.
// tests/contract/settings-carry.test.ts and the two engine tests hold each engine to it.

/** The parameter names a template declares, or undefined when the text is not a template. */
export function declaredParameterNames(templateText: string): ReadonlySet<string> | undefined {
  let template: unknown;
  try {
    template = JSON.parse(templateText);
  } catch {
    return undefined;
  }
  if (typeof template !== "object" || template === null) return undefined;
  const parameters = (template as { Parameters?: unknown }).Parameters;
  return typeof parameters === "object" && parameters !== null ? new Set(Object.keys(parameters)) : new Set();
}

/**
 * The deployed parameters an upgrade must send as UsePreviousValue: each one the stack holds, the template declares and the upgrade does not supply, in the stack's own order.
 * `declared` undefined (no template to read) carries nothing: the caller has no way to know which names CloudFormation would refuse.
 */
export function carriedParameterNames(input: { deployed: Iterable<string>; declared: ReadonlySet<string> | undefined; supplied: Iterable<string> }): string[] {
  if (input.declared === undefined) return [];
  const supplied = new Set(input.supplied);
  return [...new Set(input.deployed)].filter((name) => input.declared!.has(name) && !supplied.has(name));
}
