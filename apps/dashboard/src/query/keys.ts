export type UserDirectoryFilter = {
  page: number;
  search: string;
  role: string | null;
  status: string | null;
  method: string | null;
};

export const queryKeys = {
  session: ["session"] as const,
  libraryOwned: ["library", "owned"] as const,
  libraryShared: ["library", "shared"] as const,
  shares: (artifactId: string) => ["artifact", artifactId, "shares"] as const,
  links: (artifactId: string) => ["artifact", artifactId, "links"] as const,
  comments: (artifactId: string, revisionId?: string) =>
    revisionId === undefined
      ? (["artifact", artifactId, "comments"] as const)
      : (["artifact", artifactId, "comments", revisionId] as const),
  accountSessions: ["account", "sessions"] as const,
  adminUsers: (filter: UserDirectoryFilter) => ["admin", "users", filter] as const,
  adminInvitations: ["admin", "invitations"] as const,
  adminAccess: ["admin", "access"] as const,
  adminSso: ["admin", "sso"] as const,
  adminPasswordPolicy: ["admin", "password-policy"] as const,
  adminSessions: (userId: string) => ["admin", "sessions", userId] as const,
  capabilities: ["auth", "capabilities"] as const,
  passwordPolicy: ["auth", "password-policy"] as const,
  invitation: (token: string) => ["auth", "invitation", token] as const,
  passwordReset: (token: string) => ["auth", "password-reset", token] as const,
  oauthClient: (clientId: string) => ["auth", "oauth-client", clientId] as const,
  oauthResume: (search: string) => ["auth", "oauth-resume", search] as const,
  document: (artifactId: string) => ["artifact", artifactId, "document"] as const,
  revisions: (artifactId: string) => ["artifact", artifactId, "revisions"] as const,
  scene: (artifactId: string) => ["artifact", artifactId, "scene"] as const,
  artifactDetail: (artifactId: string) => ["artifact", artifactId, "detail"] as const,
};
