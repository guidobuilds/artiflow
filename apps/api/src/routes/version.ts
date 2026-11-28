import { Hono } from "hono";

export type BuildInfo = {
  version: string;
  revision: string;
};

export function buildInfoFromEnv(env: Record<string, string | undefined> = process.env): BuildInfo {
  const version = env.ARTIFLOW_BUILD_VERSION?.trim();
  const revision = env.ARTIFLOW_BUILD_REVISION?.trim();

  return {
    version: version === undefined || version === "" ? "dev" : version,
    revision: revision === undefined || revision === "" ? "unknown" : revision,
  };
}

export function createVersionApp(build: BuildInfo) {
  const app = new Hono();

  app.get("/api/version", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ version: build.version, revision: build.revision });
  });

  return app;
}
