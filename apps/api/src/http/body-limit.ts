import type { Context, MiddlewareHandler } from "hono";

export type BodySurface =
  | { kind: "document-save"; limitBytes: number }
  | { kind: "comment"; limitBytes: number }
  | { kind: "mcp"; limitBytes: number };

export const bodyLimitFor = (surface: BodySurface): number => {
  switch (surface.kind) {
    case "document-save":
      return surface.limitBytes;
    case "comment":
      return surface.limitBytes;
    case "mcp":
      return surface.limitBytes;
  }
};

export const bodyLimit = (surface: BodySurface): MiddlewareHandler => {
  const limit = bodyLimitFor(surface);
  return async (c: Context, next) => {
    const declared = c.req.header("content-length");
    if (declared !== undefined && Number.isFinite(Number(declared)) && Number(declared) > limit) {
      return c.json({ error: "too_large", maxBytes: limit }, 413);
    }
    await next();
  };
};
