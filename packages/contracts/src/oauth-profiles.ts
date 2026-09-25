/**
 * Where an administrator's browser signs a bot user in, per connector type, for
 * `agentx admin credential authorize`. The broker reads only `tokenUrl`, through the connector
 * type in the gateway. Values are the vendor's own and are the same for every organization; the
 * organization's app (its client ID and secret) lives in its own Secrets Manager secret.
 */
export interface OAuthAuthorizationProfile {
  /** The vendor's authorization endpoint. */
  readonly authorizeUrl: string;
  /** The vendor's token endpoint, for the code exchange and every refresh. */
  readonly tokenUrl: string;
  /** RFC 8707 resource indicator sent with the authorization request, when the vendor requires one. */
  readonly resource?: string;
  /** The redirect URI the administrator registers in the vendor app. The CLI listens on its port, on 127.0.0.1. */
  readonly redirectUri: string;
}

export const OAUTH_AUTHORIZATION_PROFILES = {
  asana: {
    authorizeUrl: "https://app.asana.com/-/oauth_authorize",
    tokenUrl: "https://app.asana.com/-/oauth_token",
    resource: "https://mcp.asana.com/v2/mcp",
    redirectUri: "http://localhost:8765/callback",
  },
} as const satisfies Record<string, OAuthAuthorizationProfile>;

export type OAuthProfileName = keyof typeof OAUTH_AUTHORIZATION_PROFILES;

/** The profile for a connector type, or undefined when that type has no browser sign-in. */
export function oauthProfile(name: string): OAuthAuthorizationProfile | undefined {
  return Object.hasOwn(OAUTH_AUTHORIZATION_PROFILES, name) ? OAUTH_AUTHORIZATION_PROFILES[name as OAuthProfileName] : undefined;
}
