export type ProviderMark = {
  readonly src: string;
  readonly monochrome: boolean;
};

const MARKS = new Map<string, ProviderMark>([
  ["google", { src: "/logos/google.svg", monochrome: false }],
  ["github", { src: "/logos/github.svg", monochrome: true }],
]);

export function providerMark(provider: string): ProviderMark | null {
  return MARKS.get(provider) ?? null;
}

export function providerLabel(provider: string): string {
  return provider === "github" ? "GitHub" : provider.charAt(0).toUpperCase() + provider.slice(1);
}
