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
  return typeof image === "string" && AVATAR_PATHS.includes(image) ? image : DEFAULT_AVATAR;
}

export function initialsOf(name: string | null | undefined): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
  if (words.length === 0) return "?";
  return words.map((word) => word.slice(0, 1).toUpperCase()).join("");
}
