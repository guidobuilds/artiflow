import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function safeInternalPath(value: string): string | null {
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\\\s]/.test(value)) return null;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return value;
}

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
