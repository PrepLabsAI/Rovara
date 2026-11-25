// CODE-PUBLIC-URL (owner DEC 254zzz505): the one place that decides what address Code gives out for its own API. Every external URL the control plane builds (the sign-in issuer and
// callbacks, CONTROL_PLANE_URL, CHANNEL_API_URL, the channel adapters' URLs and link origin, the stack outputs an operator copies into Slack, GitHub and Linear) goes through
// `publicApiBase` / `publicApiUrl` below. tests/contract/public-api-url-no-bypass.test.ts fails if any other file in infra/lib composes the API's own host into a URL.
//
// The stack parameter `PublicApiUrl` (packages/contracts/src/public-api-url.ts) is an https origin or empty. Empty: the base is the API's own `https://<id>.execute-api.<region>.amazonaws.com`,
// exactly as before, so an install that does not set it changes in no way. Set: the base is the parameter, a permanent address that a rebuilt API does not change.
// `attrApiEndpoint` stays in use for Lambda permissions' neighbours, the API mapping and the raw `ApiEndpoint` output (`rawApiEndpoint`), which keeps naming the API itself.
import { Aws, CfnCondition, CfnParameter, Fn, Stack, Token, type aws_apigatewayv2 as apigwv2 } from "aws-cdk-lib";
import { PUBLIC_API_URL_MAX_LENGTH, PUBLIC_API_URL_PARAMETER, PUBLIC_API_URL_PATTERN } from "@agentx/contracts";

const CONDITION_ID = "HasPublicApiUrl";

export interface PublicApiUrlSetting {
  readonly parameter: CfnParameter;
  readonly isSet: CfnCondition;
}

/** The parameter and its condition, declared once per stack (by whichever construct asks first; control-plane.ts asks early so the parameter sits with the other install parameters). */
export function declarePublicApiUrl(stack: Stack): PublicApiUrlSetting {
  const existing = stack.node.tryFindChild(PUBLIC_API_URL_PARAMETER);
  if (existing instanceof CfnParameter) return { parameter: existing, isSet: stack.node.findChild(CONDITION_ID) as CfnCondition };
  const parameter = new CfnParameter(stack, PUBLIC_API_URL_PARAMETER, {
    type: "String",
    default: "",
    maxLength: PUBLIC_API_URL_MAX_LENGTH,
    allowedPattern: PUBLIC_API_URL_PATTERN,
    description: "The control plane API's permanent public address, an https origin such as https://api.example.com with no path (empty, the default: the API's own execute-api host). Setting or changing it on a running install changes its token issuer",
  });
  const isSet = new CfnCondition(stack, CONDITION_ID, { expression: Fn.conditionNot(Fn.conditionEquals(parameter.valueAsString, "")) });
  return { parameter, isSet };
}

/** The API's own host (`https://<id>.execute-api.<region>.amazonaws.com`): for the raw `ApiEndpoint` output and nothing that is given to an outside party. */
export function rawApiEndpoint(api: apigwv2.CfnApi): string {
  return api.attrApiEndpoint;
}

/** The base of every external URL: the configured PublicApiUrl, or the API's own host while it is empty. No trailing slash. */
export function publicApiBase(api: apigwv2.CfnApi): string {
  const { parameter, isSet } = declarePublicApiUrl(Stack.of(api));
  return Token.asString(Fn.conditionIf(isSet.logicalId, parameter.valueAsString, rawApiEndpoint(api)));
}

/** An external URL on the API: the base and a path that starts with a slash. */
export function publicApiUrl(api: apigwv2.CfnApi, path: string): string {
  if (!path.startsWith("/")) throw new Error(`a public API URL path starts with a slash, got ${path}`);
  return `${publicApiBase(api)}${path}`;
}

/** The sign-in issuer, which follows the base (so a rebuilt API keeps the issuer Cloud's keys, meters and Bedrock external ids are keyed on). */
export function publicApiIssuer(api: apigwv2.CfnApi): string {
  return publicApiUrl(api, "/v1/auth");
}

/** The host of a set PublicApiUrl, or the empty string: what the broker's packed setting holds (a URL's slashes cannot be packed). */
export function publicApiHostSetting(stack: Stack): string {
  const { parameter, isSet } = declarePublicApiUrl(stack);
  return Token.asString(Fn.conditionIf(isSet.logicalId, Fn.select(1, Fn.split("://", parameter.valueAsString)), ""));
}

/** The same host, or nothing at all (`AWS::NoValue`) while the parameter is empty: an entry of a list, such as the DNS firewall's allow list. */
export function publicApiHostEntry(setting: PublicApiUrlSetting): string {
  const { parameter, isSet } = setting;
  return Token.asString(Fn.conditionIf(isSet.logicalId, Fn.select(1, Fn.split("://", parameter.valueAsString)), Aws.NO_VALUE));
}
