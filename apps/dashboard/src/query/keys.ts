export type UserDirectoryFilter = {
  page: number;
  search: string;
  role: string | null;
  status: string | null;
  method: string | null;
};

const auth = ["auth"] as const;
const artifact = ["artifact"] as const;
const library = ["library"] as const;
const account = ["account"] as const;
const admin = ["admin"] as const;

export const queryKeys = {
  auth: {
    all: auth,
    session: [...auth, "session"] as const,
    capabilities: [...auth, "capabilities"] as const,
    passwordPolicy: [...auth, "password-policy"] as const,
    invitation: (token: string) => [...auth, "invitation", token] as const,
    passwordReset: (token: string) => [...auth, "password-reset", token] as const,
    oauthClient: (clientId: string) => [...auth, "oauth-client", clientId] as const,
    oauthResume: (search: string) => [...auth, "oauth-resume", search] as const,
  },
  artifact: {
    all: artifact,
    byId: (artifactId: string) => [...artifact, artifactId] as const,
    shares: (artifactId: string) => [...artifact, artifactId, "shares"] as const,
    links: (artifactId: string) => [...artifact, artifactId, "links"] as const,
    comments: (artifactId: string, revisionId?: string) =>
      revisionId === undefined
        ? ([...artifact, artifactId, "comments"] as const)
        : ([...artifact, artifactId, "comments", revisionId] as const),
    document: (artifactId: string) => [...artifact, artifactId, "document"] as const,
    revisions: (artifactId: string) => [...artifact, artifactId, "revisions"] as const,
    scene: (artifactId: string) => [...artifact, artifactId, "scene"] as const,
    detail: (artifactId: string) => [...artifact, artifactId, "detail"] as const,
  },
  library: {
    all: library,
    owned: [...library, "owned"] as const,
    shared: [...library, "shared"] as const,
  },
  account: {
    all: account,
    sessions: [...account, "sessions"] as const,
  },
  admin: {
    all: admin,
    users: (filter: UserDirectoryFilter) => [...admin, "users", filter] as const,
    invitations: [...admin, "invitations"] as const,
    access: [...admin, "access"] as const,
    sso: [...admin, "sso"] as const,
    passwordPolicy: [...admin, "password-policy"] as const,
    sessions: (userId: string) => [...admin, "sessions", userId] as const,
  },
};
