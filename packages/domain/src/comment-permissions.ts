export type ArtifactAccess = "owner" | "editor" | "commenter" | "reader";

export type ArtifactPermissions = {
  readonly comment: boolean;
  readonly resolve: boolean;
  readonly deleteAny: boolean;
  readonly manage: boolean;
};

const DENIED: ArtifactPermissions = { comment: false, resolve: false, deleteAny: false, manage: false };

const GRANTED: Record<ArtifactAccess, ArtifactPermissions> = {
  owner: { comment: true, resolve: true, deleteAny: true, manage: true },
  editor: { comment: true, resolve: true, deleteAny: false, manage: false },
  commenter: { comment: true, resolve: true, deleteAny: false, manage: false },
  reader: DENIED,
};

const isAccess = (access: string): access is ArtifactAccess => Object.hasOwn(GRANTED, access);

export const artifactPermissions = (access: string | undefined): ArtifactPermissions =>
  access !== undefined && isAccess(access) ? GRANTED[access] : DENIED;
