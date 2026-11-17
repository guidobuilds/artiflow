---
title: API authentication
description: >-
  How a client authenticates against the public /api/v1 API of an Artiflow instance: resource
  discovery, OAuth 2.1 with PKCE, scopes, and token lifetimes.
sidebar:
  order: 1
---

Every Artiflow instance publishes a JSON HTTP API under `/api/v1` on its own origin, and every request
to it is **bearer-only**: it authenticates with an OAuth 2.1 access token issued by that same instance.
There is no static API key to copy, and the API never reads a dashboard cookie.

This page covers the credential on its own: discover the resource, register a client, get a token, and
know which scope an operation needs. A client that already holds a token needs nothing more than the
`Authorization` header form below.

## Shell variables used below

```sh
ARTIFLOW_ORIGIN="https://artifacts.example.com"   # your instance origin, no trailing slash
ARTIFLOW_TOKEN="..."                              # access token obtained by your OAuth client
```

The token comes from your OAuth client; nothing here asks you to paste a secret into a committed file.

## Discover the API resource

```sh
curl -sS "$ARTIFLOW_ORIGIN/.well-known/oauth-protected-resource/api/v1"
```

```json
{
  "resource": "https://artifacts.example.com/api/v1",
  "authorization_servers": ["https://artifacts.example.com/api/auth"],
  "scopes_supported": ["artifacts:read", "artifacts:write", "comments:write", "shares:manage"],
  "bearer_methods_supported": ["header"]
}
```

The document is served with `cache-control: no-store`. The authorization server publishes its own
metadata at `/.well-known/oauth-authorization-server/api/auth`, listing the same scopes plus
`offline_access`, a `refresh_token` grant, and the client registration endpoint. The MCP endpoint has a
separate resource document; see [Connect an agent](/docs/connect/mcp/).

## Get an access token

Building a client means three requests, all against `$ARTIFLOW_ORIGIN`:

1. **Register** — `POST /api/auth/oauth2/register` with RFC 7591 JSON client metadata. Registration is
   open to anonymous public clients (`token_endpoint_auth_method: "none"`), which is what a native or
   CLI client is. It grants no access by itself.
2. **Authorize** — open `/api/auth/oauth2/authorize` in a browser with `response_type=code`,
   `client_id`, `redirect_uri`, `state`, a PKCE `code_challenge` (S256) and
   `resource=$ARTIFLOW_ORIGIN/api/v1`. The `resource` parameter is **required**: without it the
   instance answers `400` with `{"error":"invalid_target"}` instead of issuing a token that no resource
   accepts. The user approves in the instance's consent page.
3. **Exchange** — `POST /api/auth/oauth2/token` form-encoded with `grant_type=authorization_code`,
   `code`, `redirect_uri` and the PKCE `code_verifier`. A verifier that does not match the challenge is
   refused with `400 {"error":"invalid_grant"}`.

Token behavior, from the instance's OAuth provider:

| Property               | Value                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| Access token           | Self-contained JWT, audience-bound to `$ARTIFLOW_ORIGIN/api/v1`, valid **900 seconds**             |
| Revocation             | Access tokens cannot be revoked server-side; keep their lifetime short and store them carefully    |
| Refresh token          | 14 days, issued only when `offline_access` is granted                                              |
| Refresh rotation       | Single use: each refresh returns a new refresh token, and replaying the old one is `invalid_grant` |
| Credential in requests | `Authorization: Bearer <access token>`; `bearer_methods_supported` is `header` only                |

Clients that only need MCP should request the MCP resource instead; the API resource is never linked
to a client automatically.

## Scopes

| Scope             | Grants                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `artifacts:read`  | List, detail, Markdown source, revisions and comments on readable artifacts                |
| `artifacts:write` | Create an artifact; save, restore and delete one you own                                   |
| `comments:write`  | Create, resolve, unresolve and delete comments                                             |
| `shares:manage`   | List, grant and revoke invitations; list, create, rotate and revoke public links           |
| `offline_access`  | A refresh token. Authorization-server only, so it is absent from the API resource document |

A token that lacks the scope a route needs is refused with `403 insufficient_scope`, not `401`, so the
client knows to request more scope rather than re-authenticate.

## Use the token

```sh
curl -sS "$ARTIFLOW_ORIGIN/api/v1/artifacts" -H "Authorization: Bearer $ARTIFLOW_TOKEN"
```

Send the credential only in that header: no cookie, no API key, no query parameter. A missing, expired
or wrong-audience token answers `401` with a `WWW-Authenticate` challenge that points at the resource
metadata above, and the client should repeat discovery and sign-in, or redeem the refresh token when it
holds one.

## Next

[Connect an agent](/docs/connect/mcp/) covers the MCP endpoint, which uses the same authorization server
with its own resource document and scopes.
