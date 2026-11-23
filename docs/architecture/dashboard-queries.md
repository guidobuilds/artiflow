# Dashboard queries

The dashboard loads HTTP data with [TanStack Query](https://tanstack.com/query). Live collaboration
(Yjs and `y-websocket`) stays a session the editor opens and destroys; it is not a query.

There is no router. Screens still mount from `apps/dashboard/src/main.tsx` by pathname. The
`QueryProvider` wraps that tree, so every screen shares one `QueryClient`.

## Client

`apps/dashboard/src/query/client.ts` builds the client. Queries do not retry and do not refetch when
the window regains focus. A screen therefore asks once when it mounts, the same way the previous
`useEffect` loads did, and a focus change does not start another request. A later screen on the same
page reads the cache when the key is still fresh.

## Keys

Keys live in `apps/dashboard/src/query/keys.ts` as `queryKeys`. A key is an array. The first element
is the domain, and later elements narrow it.

| Key                                                                                                          | Domain                                                            |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `queryKeys.session`                                                                                          | The signed-in user, shared by every screen.                       |
| `queryKeys.libraryOwned`, `queryKeys.libraryShared`                                                          | Library lists.                                                    |
| `queryKeys.shares(id)`, `queryKeys.links(id)`, `queryKeys.comments(id)`                                      | One artifact.                                                     |
| `queryKeys.accountSessions`                                                                                  | The signed-in account's sessions.                                 |
| `queryKeys.adminUsers(filter)`                                                                               | One directory page. The filter is part of the key.                |
| `queryKeys.adminInvitations`, `queryKeys.adminAccess`, `queryKeys.adminSso`, `queryKeys.adminPasswordPolicy` | Administration configuration and invitations.                     |
| `queryKeys.adminSessions(userId)`                                                                            | Sessions of one account, as an administrator.                     |
| `queryKeys.capabilities`, `queryKeys.passwordPolicy`                                                         | Sign-in methods and the password rules shown on the auth screens. |
| `queryKeys.invitation(token)`, `queryKeys.passwordReset(token)`, `queryKeys.oauthClient(clientId)`           | One-time auth links and the consent client.                       |
| `queryKeys.document(id)`, `queryKeys.revisions(id)`, `queryKeys.scene(id)`, `queryKeys.artifactDetail(id)`   | Editor and canvas reads.                                          |

Add a key here before adding a `useQuery`. Do not invent a second array for the same read.

## Session

`useSession` (`query/session.ts`) is the only session read. Its `staleTime` is `Infinity`, so the
mounting screens share one `getSession` for the life of the page. Sign-out and the other auth
transitions navigate with a full page load, which creates a new client. `getSession` itself stays
the HTTP function; mutations that must prove a session still call it.

## Library

`libraryOwnedQuery` and `librarySharedQuery` load the two lists. They refetch every
`LIBRARY_POLL_MS`, including while the tab is in the background, which is the interval the
previous timer used. Deleting an artifact calls `invalidateLibrary`, and both lists refetch.
A sign-in refusal from either list sends the browser to login. A failed shared list leaves
the owned list on screen; a failed owned list is the error the page shows.

## After a mutation

A write that used to bump a `revision` counter invalidates the key of the list it changed
(`invalidateQueries`). The query refetches. A write that already returned the new record may
`setQueryData` with that record instead of fetching it again. Do not keep a counter whose only job
is to re-run an effect.
