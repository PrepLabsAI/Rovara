import { expect } from "vitest";

type Resource = { Type: string; Properties: Record<string, unknown> };

/** Every standard attribute the app client may write: all the standard ones except email_verified and phone_number_verified (Cognito's own names); email stays (it is required, Cognito refuses a list without it). */
export const EXPECTED_CLIENT_WRITE_ATTRIBUTES = [
  "address", "birthdate", "email", "family_name", "gender", "given_name", "locale", "middle_name", "name", "nickname", "phone_number",
  "picture", "preferred_username", "profile", "updated_at", "website", "zoneinfo",
] as const;

/**
 * COGNITO-WRITE-ATTRIBUTES: the identity stack gains exactly two in-place property changes, and nothing else: the "Cli" app client's WriteAttributes
 * (no verified flags; email stays, it is required) and the pool's UserAttributeUpdateSettings (verify an email before it changes). Both are checked here to be exactly
 * this, then taken out, so the rest of the template must still match the recorded snapshot. Takes them out of `input` itself and returns it; clone first to keep the original.
 */
export function withoutCognitoWriteAttributes<T>(input: T): T {
  const resources = Object.values((input as { Resources: Record<string, Resource> }).Resources);
  const pools = resources.filter((resource) => resource.Type === "AWS::Cognito::UserPool");
  const clients = resources.filter((resource) => resource.Type === "AWS::Cognito::UserPoolClient");
  expect(pools).toHaveLength(1);
  expect(clients).toHaveLength(1);
  expect(pools[0]!.Properties.UserAttributeUpdateSettings).toStrictEqual({ AttributesRequireVerificationBeforeUpdate: ["email"] });
  expect(clients[0]!.Properties.WriteAttributes).toStrictEqual([...EXPECTED_CLIENT_WRITE_ATTRIBUTES]);
  delete pools[0]!.Properties.UserAttributeUpdateSettings;
  delete clients[0]!.Properties.WriteAttributes;
  return input;
}
