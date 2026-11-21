export const AVATAR_PATHS: readonly string[] = [
  "/avatars/avatar-1.png",
  "/avatars/avatar-2.png",
  "/avatars/avatar-3.png",
  "/avatars/avatar-4.png",
];

export const DEFAULT_AVATAR: string = AVATAR_PATHS[0]!;

export function randomAvatar(random: () => number = Math.random): string {
  const index = Math.min(AVATAR_PATHS.length - 1, Math.floor(random() * AVATAR_PATHS.length));
  return AVATAR_PATHS[index]!;
}

export function avatarSource(image: string | null | undefined): string {
  if (typeof image !== "string") return DEFAULT_AVATAR;
  if (AVATAR_PATHS.includes(image)) return image;
  try {
    return new URL(image).protocol === "https:" ? image : DEFAULT_AVATAR;
  } catch {
    return DEFAULT_AVATAR;
  }
}
