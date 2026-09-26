import { DeleteParameterCommand, GetParameterCommand, GetParametersByPathCommand, PutParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";

/** What environment settings and the environment lock need from SSM Parameter Store. */
export interface ParameterStore {
  get(name: string): Promise<{ value: string; version: number } | undefined>;
  /** Overwrites unless createOnly; createOnly throws ParameterExistsError when present. */
  put(name: string, value: string, options?: { createOnly?: boolean }): Promise<void>;
  /** Deleting an absent parameter is not an error. */
  delete(name: string): Promise<void>;
  /** Parameter names (not values) under a path, recursively. */
  list(path: string): Promise<string[]>;
}

export class ParameterExistsError extends Error {
  constructor(name: string) {
    super(`parameter ${name} already exists`);
    this.name = "ParameterExistsError";
  }
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : undefined);

export function ssmParameterStore(client: SSMClient): ParameterStore {
  return {
    async get(name) {
      try {
        const { Parameter } = await client.send(new GetParameterCommand({ Name: name }));
        return Parameter?.Value === undefined ? undefined : { value: Parameter.Value, version: Parameter.Version ?? 0 };
      } catch (error) {
        if (errorName(error) === "ParameterNotFound") return undefined;
        throw error;
      }
    },
    async put(name, value, options = {}) {
      try {
        await client.send(new PutParameterCommand({ Name: name, Value: value, Type: "String", Overwrite: !options.createOnly }));
      } catch (error) {
        if (errorName(error) === "ParameterAlreadyExists") throw new ParameterExistsError(name);
        throw error;
      }
    },
    async delete(name) {
      try {
        await client.send(new DeleteParameterCommand({ Name: name }));
      } catch (error) {
        if (errorName(error) !== "ParameterNotFound") throw error;
      }
    },
    async list(path) {
      const names: string[] = [];
      let NextToken: string | undefined;
      do {
        const page = await client.send(new GetParametersByPathCommand({ Path: path, Recursive: true, ...(NextToken ? { NextToken } : {}) }));
        names.push(...(page.Parameters ?? []).flatMap((parameter) => (parameter.Name ? [parameter.Name] : [])));
        NextToken = page.NextToken;
      } while (NextToken);
      return names;
    },
  };
}
