---
title: Identity providers
description: Connect one enterprise OIDC provider, register the redirect URI, restrict Entra ID to one tenant and Google Workspace or GitHub to your organisation, and verify that a foreign or personal account cannot get in.
sidebar:
  order: 11
---

An instance offers three kinds of sign-in: password, Google and GitHub as social methods, and one
enterprise connection over OIDC. The first two are configured on [Access](/docs/self-hosting/administration/#access-methods);
the connection is configured on `/admin/sso`, reached from the Access page. SAML is not supported by
this build, and there is exactly one enterprise connection per instance.

This page covers what to register at the provider, which barrier each rule creates, what the product
itself enforces, and how to prove that an account from another company or a personal account cannot
get in.

## What the connection needs

| Field              | What it is                                                                  |
| ------------------ | --------------------------------------------------------------------------- |
| Display name       | The label on the sign-in button while the connection is published           |
| Issuer             | The HTTPS issuer of one concrete application registration                   |
| Client id          | The non-secret identifier of that registration                              |
| Client secret      | Stored encrypted; shown as presence only and never read back                |
| Scopes             | Requested scopes, `openid profile email` by default, at least one required  |
| Just-in-time       | Whether a first authorized sign-in creates a member account                 |
| Allowed domains    | Bare hostnames, required whenever just-in-time provisioning is on           |
| Accept any account | Explicit acceptance of every account the provider authenticates             |

Register this redirect URI at the provider, exactly:

```text
<your public origin>/api/auth/sso/callback/artiflow
```

The page shows the same address with a copy action, derived from `ARTIFLOW_PUBLIC_ORIGIN` in one
place, so a change of origin moves it and the provider registration has to follow. Nothing else has
to be registered: discovery, the JWKS and the user information endpoint are read from the provider.

The credential needs `ARTIFLOW_SECRET_ENCRYPTION_KEY`. Without it the connection can be described and
saved but not enabled with a secret, and the page says so instead of storing it unprotected. Keep that
key stable: a stored credential that can no longer be decrypted leaves the connection unable to start
a sign-in, and re-entering the secret is the way back. See
[Configuration](/docs/reference/configuration/).

## What is checked when you save

The issuer and discovery checks run on the save that enables the connection, not on a save that leaves
it disabled: a disabled document stores what you typed. The scope, domain and credential checks run on
every save. Each refusal is a named code with its own wording on the page, and nothing is stored when
one fires.

| Refusal                                 | Rule                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `sso_issuer_insecure`                   | The issuer must be HTTPS.                                                                  |
| `sso_issuer_invalid`                    | One concrete URL, without a query or a fragment.                                            |
| `sso_issuer_templated`                  | A multi-tenant authority — `/common`, `/organizations`, `/consumers` — or a placeholder.    |
| `sso_discovery_unreachable`             | `<issuer>/.well-known/openid-configuration` failed, timed out or answered an error status.  |
| `sso_discovery_invalid`                 | The answer is not JSON, or carries no `issuer`.                                             |
| `sso_issuer_mismatch`                   | The advertised issuer differs from the address you gave.                                    |
| `sso_display_name_required`             | An enabled connection needs the label people will see.                                      |
| `sso_client_id_required`                | An enabled connection needs its client id.                                                  |
| `sso_credential_required`               | An enabled connection needs a stored credential.                                            |
| `sso_scopes_invalid`                    | At least one requested scope.                                                               |
| `sso_domain_required`                   | Just-in-time provisioning needs at least one allowed domain.                                |
| `sso_domain_invalid`                    | Domains are bare hostnames: no scheme, path, wildcard or address.                           |
| `sso_sign_in_unavailable`               | The build cannot start a sign-in through the connection, so publishing it would lock every non-administrator out of the other methods. |
| `secret_encryption_unconfigured`        | A credential cannot be stored without the encryption key.                                   |

A refused save stores no document, no credential and no log line. An applied save stores both in one
transaction, writes one `access.sso.updated` line and takes effect on the next request, without a
restart.

### The readiness rule

Publishing a connection replaces the password form and the social buttons with one action, so the
server only lets a document be enabled while that build can actually start the sign-in. The check runs
after the field and discovery checks, so a document that would be refused for its own reason is still
refused for that reason rather than for readiness, and a build that cannot start the flow answers
`sso_sign_in_unavailable` and keeps the document disabled. That refusal exists to prevent a lockout:
publishing a connection nobody can use would leave every non-administrator with no way in.

This release starts the flow, so the rule passes and the page shows no readiness warning. On a build
where it refuses, the document can still be saved with the state set to Disabled and enabled later,
once the running build can start the sign-in.

## Microsoft Entra ID

**At the provider.** Register a single-tenant application (Accounts in this organizational directory
only), add the redirect URI above, and create a client secret. Use the tenant-scoped issuer that the
app registration publishes, in the form `https://login.microsoftonline.com/<tenant id>/v2.0`. If you
also want to limit who inside the tenant may use it, use the enterprise application's assignment
requirement or a Conditional Access policy; this product does not read group claims.

**What the product enforces on top of that.** `/common`, `/organizations` and `/consumers` are
refused at save time, and so is any issuer the discovery document advertises with a `{tenantid}`
placeholder, so a multi-tenant authority cannot be configured by mistake. A discovery answer whose
issuer differs from the address you gave is refused, so the parameter cannot drift from the
registration.

**At sign-in.** The saved issuer is the pin. The product derives the tenant from its last path segment
— dropping a version segment such as `v2.0`, lower-cased — and requires the ID token's `iss` to equal
the saved issuer and its `tid`, when present, to equal that derived tenant. A token from another
tenant, from an issuer this build did not pin, or that asserts a tenant while the issuer names none, is
refused with `sso_tenant_mismatch` before any account is looked up. An allowed domain never rescues
that refusal.

**What Entra enforces, not the product.** The single-tenant registration is what actually stops a user
from another company at the front door: Microsoft refuses the authorization request before Artiflow
sees anything. Assignments, Conditional Access and MFA are the provider's controls too. The product
trusts any account the provider authenticates, on an allowed domain, up to the rules below.

### Prove it

1. On `/admin/sso`, enter `https://login.microsoftonline.com/common/v2.0` and try to enable. Expect
   `sso_issuer_templated`, and nothing stored.
2. Enter the tenant-scoped issuer instead and enable. Expect the save to succeed, the sign-in page to
   show one button with your display name, and one `access.sso.updated` line in the log.
3. Sign in through that button with an account from **another** tenant. Expect Entra to refuse the
   request; if a guest account is allowed into your tenant, expect Artiflow to refuse it with
   `sso_domain_not_allowed` or `sso_account_unknown` unless its domain is allowed and provisioning is on.
4. Sign in with an address that has no account while provisioning is off. Expect
   `sso_account_unknown`, and no account created.
5. Deactivate a person who has signed in through the connection, then have them try again. Expect
   `sso_account_deactivated`; the connection never reactivates an account.
6. Read the log: every save, and every element of the matrix below that was refused, is one line with
   no address, token or secret in it.

## Google and GitHub

These are social methods, not the enterprise connection: they link to an account by the address the
provider reports as verified, and the product creates no account from either of them. Sign-up through
a provider is closed in every profile, so a Google or GitHub identity can only open an account that
already exists with the same address.

**What the product does not enforce.** It does not read the Google Workspace domain, the `hd` claim, or
GitHub organisation membership. A Google account is trusted on its verified address, whatever
organisation it belongs to. Restricting the method to your own organisation is therefore the
provider's job:

- **Google Workspace.** In the Google Cloud project that owns the OAuth client, set the OAuth consent
  screen user type to **Internal**, which is available to a Workspace organisation and makes Google
  refuse every account outside it. Then add the client id and secret on
  [Access](/docs/self-hosting/administration/#access-methods).
- **GitHub.** Own the OAuth app under the organisation and enable the organisation's OAuth App access
  restrictions, so only approved members can authorise it.

**Prove it.** Sign out of Artiflow, start the Google sign-in and choose a personal Google account.
Google refuses before Artiflow is reached, with its internal-app error. Repeat with a GitHub account
outside the organisation and expect GitHub to refuse the authorisation. If a personal account reaches
the Artiflow sign-in page and is refused there only because no account uses that address, the provider
is not restricting anything: an invitation to that address would let it in.

While the enterprise connection is published, both social methods are administrator-only anyway: see
the next section.

## The sign-in page under a published connection

While the connection is enabled the page renders one action labelled with the administrator's display
name and asks for no email first; the password form and the social buttons are not rendered. The
browser reads that answer from `GET /api/auth/capabilities` rather than guessing, so the page cannot
disagree with the server.

The alternative methods are emergency access for administrators. They are revealed by opening
`/login?fallback=1`, under copy that states the alternative is for administrators and that opening the
page grants nothing by itself. That is literal: the query parameter changes rendering only, nothing on
the server authorises an action from it, and the server-side lock refuses a password or social sign-in
that does not resolve to an active administrator. The password branch answers a member, an unknown
address, a deactivated account and a wrong password with one identical rejected-credentials answer,
and the social branch destroys the session it just created before the response leaves, so the redirect
carries no usable credential. Every admitted and every refused attempt writes one `login.fallback.used` line.

An instance where neither password nor a social method is enabled publishes no alternative at all: no
emergency link is rendered, because there is nothing behind it.

## Just-in-time provisioning and linking

The connection decides admission in one place, and every refusal is a named code the sign-in page
renders in its own words — never text supplied by the identity provider.

| Existing account                | Evidence                                                    | Outcome                                   |
| ------------------------------- | ----------------------------------------------------------- | ----------------------------------------- |
| none, provisioning on           | address on an allowed domain, or any-account accepted        | create `member`, `active`, then link      |
| none, provisioning on           | domain not allowed, any-account not accepted                 | `sso_domain_not_allowed`                  |
| none, provisioning off          | —                                                           | `sso_account_unknown`                     |
| same address                    | verified email claim, no other enterprise identity           | link, keeping the stored profile          |
| same address                    | no verified claim, issuer pinned and domain allowed          | link                                      |
| same address                    | identity bound to another account, or account holds another  | `sso_identity_conflict`                   |
| same address                    | no verified claim and domain not allowed                     | `sso_email_unverified`                    |
| any                             | matched account is deactivated                              | `sso_account_deactivated`                 |
| any                             | token from another tenant, or an unpinned issuer             | `sso_tenant_mismatch`                     |

A created account is always a member, active, with the address lower-cased and the verified flag taken
from the ID token claim; a `role`, `groups` or `roles` claim grants nothing. A linked account keeps its
name, address, role and status: linking an enterprise identity never rewrites a profile. Accepting any
account lifts the domain barrier for new accounts only — linking an existing account without a verified
claim still needs an allowed domain. Two simultaneous first sign-ins end with one account, one identity
and two sessions.

Every refusal leaves the stored rows untouched: no account, identity or session is written, and the
account that matched keeps its status and its address.

## Next

[Recover access](/docs/self-hosting/recovery/) covers what to do when nobody can sign in, and
[Administer accounts and sign-in](/docs/self-hosting/administration/) covers the rest of the area.
