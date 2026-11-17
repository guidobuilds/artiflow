import { artifactSchema } from "./artifact-schema.ts";
import { authSchema } from "./auth-schema.ts";

export const appSchema = { ...authSchema, ...artifactSchema };
