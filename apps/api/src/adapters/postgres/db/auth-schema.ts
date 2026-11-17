import { inviteSchema } from "./invite-schema.ts";
import { oauthSchema } from "./oauth-schema.ts";
import { passwordResetSchema } from "./password-reset-schema.ts";
import { authSchema as baseAuthSchema } from "./schema.ts";

export const authSchema = { ...baseAuthSchema, ...oauthSchema };

export const registrationAuthSchema = { ...authSchema, ...inviteSchema, ...passwordResetSchema };
