import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export const sidebar = [
  {
    label: "Start here",
    items: [{ label: "Overview", link: "/docs/" }, { autogenerate: { directory: "docs/start" } }],
  },
  { label: "Connect tools", items: [{ autogenerate: { directory: "docs/connect" } }] },
  { label: "Concepts", items: [{ autogenerate: { directory: "docs/concepts" } }] },
  { label: "Artifact types", items: [{ autogenerate: { directory: "docs/artifacts" } }] },
  { label: "Guides", items: [{ autogenerate: { directory: "docs/guides" } }] },
  { label: "Reference", items: [{ autogenerate: { directory: "docs/reference" } }] },
  { label: "Self-hosting", items: [{ autogenerate: { directory: "docs/self-hosting" } }] },
  { label: "Contribute", items: [{ autogenerate: { directory: "docs/contributing" } }] },
];

export default defineConfig({
  site: "https://artiflow.dev",
  integrations: [
    starlight({
      title: "Artiflow",
      description: "The open, cross-agent artifact library.",
      logo: {
        light: "./src/assets/wordmark-light.svg",
        dark: "./src/assets/wordmark-dark.svg",
        alt: "artiflow",
        replacesTitle: true,
      },
      favicon: "/favicon.svg",
      customCss: ["./src/styles/docs.css"],
      sidebar,
    }),
  ],
});
