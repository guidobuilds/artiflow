import type { Capabilities } from "./auth-client.ts";

export const FALLBACK_PARAMETER = "fallback";
export const FALLBACK_PATH = "/login?fallback=1";

export const EMERGENCY_TITLE = "Administrator emergency access";
export const EMERGENCY_COPY =
  "Only administrator accounts can sign in here while the connection is enabled. This page is here for " +
  "emergencies, and opening it grants no access by itself: every other account is refused.";
export const EMERGENCY_REACHABLE = "Administrators can sign in through the emergency access.";

export const CONNECTION_UNNAMED = "Single sign-on";
export const METHODS_UNAVAILABLE =
  "Could not load the sign-in methods for this instance. Reload the page and try again.";

export const connectionUnavailable = (label: string): string =>
  `${label} is configured for this instance. Signing in through it is not available yet in this build.`;

export type ConnectionNotice = {
  readonly label: string;
  readonly statement: string;
  readonly access: string | null;
};

export type EmergencyNotice = {
  readonly title: string;
  readonly copy: string;
};

export type LoginSurface = {
  readonly connection: ConnectionNotice | null;
  readonly fallbackLink: boolean;
  readonly emergency: EmergencyNotice | null;
  readonly password: boolean;
  readonly providers: readonly string[];
};

const NOTHING_ON_OFFER: LoginSurface = Object.freeze({
  connection: null,
  fallbackLink: false,
  emergency: null,
  password: false,
  providers: Object.freeze([]),
});

export function fallbackRequested(search: string): boolean {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return params.get(FALLBACK_PARAMETER) === "1";
}

export function loginSurface(capabilities: Capabilities | null, search: string): LoginSurface {
  if (capabilities === null) return NOTHING_ON_OFFER;
  const connection = capabilities.sso;
  if (connection === undefined) {
    return {
      connection: null,
      fallbackLink: false,
      emergency: null,
      password: capabilities.emailPassword,
      providers: capabilities.socialProviders,
    };
  }
  const label = connection.displayName ?? CONNECTION_UNNAMED;
  const alternative = connection.fallbackAvailable === true;
  const revealed = alternative && fallbackRequested(search);
  return {
    connection: {
      label,
      statement: connectionUnavailable(label),
      access: alternative ? EMERGENCY_REACHABLE : null,
    },
    fallbackLink: alternative && !revealed,
    emergency: revealed ? { title: EMERGENCY_TITLE, copy: EMERGENCY_COPY } : null,
    password: revealed && capabilities.emailPassword,
    providers: revealed ? capabilities.socialProviders : [],
  };
}
