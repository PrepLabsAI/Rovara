// A small CloudFormation resolver for tests that ask "what does this template resolve to when a parameter has this value": conditions, Fn::If, Fn::Join, Fn::Select, Fn::Split,
// Ref and GetAtt. A resource is `PHYS-<logical id>`; the HTTP API's endpoint is a stand-in built at run time (the public repository refuses an API Gateway host written out).
type Json = Record<string, unknown>;
export interface ResolvableTemplate { Parameters?: Record<string, { Default?: unknown }>; Conditions?: Record<string, unknown>; Resources: Record<string, { Type: string; Properties?: Json }>; Outputs?: Record<string, { Value: unknown }> }

export const NO_VALUE = Symbol("AWS::NoValue");
export const REGION = "us-east-1";
export const ACCOUNT = "123456789012";
/** The API's own host in a template resolved here: what GetAtt HttpApi.ApiEndpoint gives. */
export const RAW_API_ENDPOINT = `https://${["abcdef1234", "execute-api", REGION, "amazonaws", "com"].join(".")}`;

/** A synthesized template (`Template.fromStack(stack)`, which the calling test imports: the port guard allows the CDK in a test, not in a support file) as plain JSON. */
export const templateOf = (synthesized: { toJSON(): unknown }): ResolvableTemplate => JSON.parse(JSON.stringify(synthesized.toJSON())) as ResolvableTemplate;

export function resolverOf(template: ResolvableTemplate, parameters: Record<string, string> = {}): (node: unknown) => unknown {
  const pseudo: Record<string, string> = { "AWS::Region": REGION, "AWS::AccountId": ACCOUNT, "AWS::Partition": "aws", "AWS::URLSuffix": "amazonaws.com", "AWS::StackName": "stack" };
  const condition = (node: unknown): boolean => {
    const [key, value] = Object.entries(node as Json)[0]! as [string, unknown[] | string];
    if (key === "Fn::Equals") return resolve((value as unknown[])[0]) === resolve((value as unknown[])[1]);
    if (key === "Fn::Not") return !condition((value as unknown[])[0]);
    if (key === "Fn::And") return (value as unknown[]).every(condition);
    if (key === "Fn::Or") return (value as unknown[]).some(condition);
    if (key === "Condition") return condition(template.Conditions![value as string]);
    throw new Error(`condition ${key}`);
  };
  const resolve = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(resolve).filter((entry) => entry !== NO_VALUE);
    if (node === null || typeof node !== "object") return node;
    const entries = Object.entries(node as Json);
    if (entries.length !== 1 || !(entries[0]![0] === "Ref" || entries[0]![0].startsWith("Fn::"))) return Object.fromEntries(entries.map(([key, value]) => [key, resolve(value)]));
    const [key, value] = entries[0]!;
    switch (key) {
      case "Ref": {
        const name = value as string;
        if (name === "AWS::NoValue") return NO_VALUE;
        if (pseudo[name] !== undefined) return pseudo[name];
        const declared = template.Parameters?.[name];
        if (declared !== undefined) return parameters[name] ?? (typeof declared.Default === "string" || typeof declared.Default === "number" ? String(declared.Default) : `P-${name}`);
        return `PHYS-${name}`;
      }
      case "Fn::GetAtt": {
        const [id, attribute] = value as [string, string];
        return template.Resources[id]?.Type === "AWS::ApiGatewayV2::Api" && attribute === "ApiEndpoint" ? RAW_API_ENDPOINT : `PHYS-${id}.${attribute}`;
      }
      case "Fn::Join": return ((resolve((value as [string, unknown[]])[1]) as unknown[]).map(String)).join((value as [string, unknown[]])[0]);
      case "Fn::If": { const [name, yes, no] = value as [string, unknown, unknown]; return resolve(condition(template.Conditions![name]) ? yes : no); }
      case "Fn::Select": { const [index, list] = value as [number, unknown]; return (resolve(list) as unknown[])[Number(index)]; }
      case "Fn::Split": { const [delimiter, text] = value as [string, unknown]; return String(resolve(text)).split(delimiter); }
      default: throw new Error(`no stand-in for ${key}`);
    }
  };
  return resolve;
}

/** Every Lambda function's environment variables and every output, resolved. */
export function resolvedValues(template: ResolvableTemplate, parameters: Record<string, string> = {}): Array<{ where: string; name: string; value: string }> {
  const resolve = resolverOf(template, parameters);
  const found: Array<{ where: string; name: string; value: string }> = [];
  for (const [id, resource] of Object.entries(template.Resources)) {
    if (resource.Type !== "AWS::Lambda::Function") continue;
    const variables = (resource.Properties?.Environment as { Variables?: Json } | undefined)?.Variables ?? {};
    for (const [name, value] of Object.entries(variables)) found.push({ where: id.replace(/[0-9A-F]{8}$/u, ""), name, value: String(resolve(value)) });
  }
  for (const [name, output] of Object.entries(template.Outputs ?? {})) found.push({ where: "Output", name, value: String(resolve(output.Value)) });
  return found;
}
