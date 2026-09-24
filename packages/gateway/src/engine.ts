import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { McpConnection } from "./mcp-client.js";
import type { CatalogTool, ConnectorContext, ConnectorDefinition } from "./types.js";
import { fingerprint, isObject } from "./util.js";

/** Derive schemas from discovery, narrow by admin policy, and bind routing outside model arguments. */
export function approveTools<Scope>(
  connection: Pick<McpConnection, "tools">,
  connector: Pick<ConnectorDefinition<Scope>, "binder">,
  context: ConnectorContext<Scope>,
): CatalogTool[] {
  const tools: CatalogTool[] = [];
  for (const upstream of connection.tools) {
    const policy = context.policy.tools.find((entry) => entry.name === upstream.name);
    if (!policy) continue;
    if (JSON.stringify(upstream.inputSchema).length > 32_768) throw new Error("MCP schema exceeded limit");
    const schema = structuredClone(upstream.inputSchema);
    // Plain object schemas only. Fail closed on shapes the narrowing cannot reason about.
    if (schema.type !== "object" || !isObject(schema.properties) || schema.$ref || schema.allOf || schema.anyOf || schema.oneOf || schema.patternProperties) continue;
    const properties = schema.properties;
    const required = Array.isArray(schema.required) ? schema.required as string[] : [];
    const bindable = (name: string) => {
      const property = properties[name];
      return isObject(property) && property.type === "string" && required.includes(name);
    };
    if (!connector.binder.properties.every(bindable)) continue;
    for (const name of connector.binder.properties) delete properties[name];
    schema.required = required.filter((name) => !connector.binder.properties.includes(name));
    if (policy.allowedArguments) {
      if ((schema.required as string[]).some((name) => !policy.allowedArguments!.includes(name))) continue;
      for (const name of Object.keys(properties)) if (!policy.allowedArguments.includes(name)) delete properties[name];
    }
    let incompatible = false;
    for (const [name, values] of Object.entries(policy.argumentValues ?? {})) {
      const property = properties[name];
      if (!isObject(property)) { incompatible = true; break; }
      const upstreamEnum = Array.isArray(property.enum) ? property.enum : undefined;
      const permitted = upstreamEnum ? values.filter((value) => upstreamEnum.includes(value)) : values;
      if (!permitted.length) { incompatible = true; break; }
      properties[name] = { ...property, enum: permitted };
      if (!(schema.required as string[]).includes(name)) (schema.required as string[]).push(name);
    }
    if (incompatible) continue;
    schema.additionalProperties = false;
    // Compile during discovery too; schemas we cannot validate must never be advertised.
    new AjvJsonSchemaValidator().getValidator(schema);
    tools.push({
      name: upstream.name,
      scope: context.scopeAlias,
      description: (upstream.description ?? upstream.name).slice(0, 16_384),
      inputSchema: schema,
      // Hashed under the feature 007 key `repository` so hashes survive the release.
      schemaHash: fingerprint({ upstream, policy, repository: context.scope }),
      access: policy.access,
    });
  }
  return tools;
}
