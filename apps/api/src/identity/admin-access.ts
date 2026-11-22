import { createAccessControl } from "better-auth/plugins/access";

import { ADMINISTRATOR_ROLE, MEMBER_ROLE } from "./roles.ts";

const administratorStatements = {
  user: ["list", "get", "update", "set-role", "set-email"],
  session: ["list", "revoke"],
} as const;

const access = createAccessControl({
  user: [...administratorStatements.user],
  session: [...administratorStatements.session],
});

export const instanceRoles = {
  [ADMINISTRATOR_ROLE]: access.newRole({
    user: [...administratorStatements.user],
    session: [...administratorStatements.session],
  }),
  [MEMBER_ROLE]: access.newRole({ user: [], session: [] }),
};
