---
title: Social sign-in
description: Register the Google and GitHub OAuth clients, paste the client id and secret on the Access page, and know which redirect URI belongs to which path, which accounts a button can open, and what a refused person sees.
sidebar:
  order: 10.5
---

Google and GitHub are the two social methods an instance can offer. They are not the enterprise
connection: a social provider asserts who a person is by matching an address, while the connection
brings its own trust rules and its own redirect URI. This page follows one provider from the console
that creates it to a button somebody can press, and states which accounts that button can open — which
is narrower than the name suggests.

The Access page, its save rules and its provenance line are described in
[Administer accounts and sign-in](/docs/self-hosting/administration/#access-methods); the enterprise
connection is [Identity providers](/docs/self-hosting/identity-providers/). This page covers what is
specific to the social path.

## Which redirect URI belongs to which path

Four addresses are easy to confuse, and registering the wrong one costs an afternoon. The first three
are derived from `ARTIFLOW_PUBLIC_ORIGIN` and are registered at a provider; the fourth is not.

| Path                         | Address                                                        | Registered at                         |
| ---------------------------- | -------------------------------------------------------------- | ------------------------------------- |
| Social — Google              | `<public origin>/api/auth/callback/google`                     | The Google OAuth client               |
| Social — GitHub              | `<public origin>/api/auth/callback/github`                     | The GitHub OAuth app                  |
| Enterprise connection (OIDC) | `<public origin>/api/auth/sso/callback/artiflow`               | The application registration          |
| Agent sign-in                | `<public origin>/login`, approval on `<public origin>/consent` | Nothing: it is a page of this product |

- The two social callbacks are the auth library's own callback paths for the providers named `google`
  and `github`. They are not interchangeable with the connection's callback, which ends in
  `/api/auth/sso/callback/artiflow` and is shown with a copy action on `/admin/sso`.
- The agent sign-in page is not a provider callback at all. An agent registers its own redirect URI —
  a loopback address or a custom scheme — with this instance's authorization server, and the person
  approves the request on `/consent`. Nothing about that flow is entered at Google or GitHub. See
  [API authentication](/docs/reference/api-authentication/).
- A change of public origin moves all four at once, so re-register the callbacks at both providers in
  the same deployment step.

## Google

**Where the client is created.** In the Google Cloud console, select the project that owns the
instance, configure an **OAuth consent screen** if the project has none, then open **APIs & Services →
Credentials → Create credentials → OAuth client ID**. The consent screen has to exist first: without it
the credential form refuses to save.

**The client must be a web application.** Choose **Web application** as the application type. It is the
type that carries a list of authorised redirect URIs, which is where the address below goes; the other
types are configured for a loopback or app-scheme redirect and are not what this instance expects.

**The authorised redirect URI.** Add this address, exactly:

```text
<your public origin>/api/auth/callback/google
```

Scheme, host and path are compared literally: a trailing slash, a different port or a path prefix does
not match, and the callback then fails at Google before Artiflow is reached. A local instance registers
its loopback origin instead of the production one.

**The consent screen decides who may sign in at all.** Two settings on that screen are the only
provider-side barrier this product has, because it reads no Workspace domain and no `hd` claim:

| Setting                                 | Effect on the button                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| Publishing status **Testing**           | Only the test users listed on the screen can authorise, up to its limit.     |
| Publishing status **In production**     | Any Google account can authorise and reach Artiflow's refusal or its sign-in |
| User type **Internal** (Workspace only) | Google refuses every account outside the organisation, before Artiflow       |
| User type **External**                  | Every Google account is a candidate; the product decides afterwards          |

So **Internal** is how a Workspace organisation restricts this method to itself, and it is Google that
enforces it. An External app in production trusts the whole of Google: what stops a foreign account
then is the refusal on the Artiflow side or nothing at all, never a check this product makes on the
organisation. See [Identity providers](/docs/self-hosting/identity-providers/#google-and-github) for
the same point from the connection's side.

**Getting the two values.** The credential page shows the **Client ID**, and the client secret appears
once when the credential is created (downloadable as JSON). Both go to `/admin/access`. A secret that
was lost is rotated in the same console, and the new value is pasted there to replace the stored one.

## GitHub

**Where the app is created.** A personal account creates it under **Settings → Developer settings →
OAuth Apps → New OAuth App**. To make the organisation the owner, create it from the organisation's
**Settings → Developer settings → OAuth Apps** instead; that ownership is what the organisation's OAuth
App access restrictions act on.

**The callback URL.** Fill **Homepage URL** with the public origin and **Authorization callback URL**
with this address, exactly:

```text
<your public origin>/api/auth/callback/github
```

**Getting the two values.** The app page shows the **Client ID**; **Generate a new client secret**
produces the secret, and it is shown once. Both go to `/admin/access`. Regenerating a secret invalidates
the previous one immediately, so a sign-in started after the rotation fails until the new value is
pasted there.

**Restricting it to your organisation.** Own the app under the organisation and enable the
organisation's **OAuth App access restrictions**, approving the app for the members you mean. GitHub
then refuses everybody else and Artiflow never sees them. The product itself reads no GitHub
organisation, team or scope membership; it trusts the address GitHub asserts.

## Paste both on the Access page

`/admin/access` holds both providers. Each row has an enablement switch, the client id, and the client
secret as a write-only field. The save rules are the Access section's and apply here unchanged:

- A stored secret is shown as presence only and can be replaced, never read back.
- Enabling a provider needs a non-blank client id and a stored secret, either already stored or
  supplied in the same save; otherwise the save is refused and nothing is stored.
- Supplying a secret needs `ARTIFLOW_SECRET_ENCRYPTION_KEY`. Without it the save is refused rather than
  storing the secret unprotected, and a secret encrypted under a key that is no longer configured is
  left out of the sign-in page while the document still says enabled. Keep that key stable and in the
  same backup as the database; see [Configuration](/docs/reference/configuration/).

The first save made here moves the provenance line to "Set by an administrator". The
`ARTIFLOW_AUTH_GOOGLE_*` and `ARTIFLOW_AUTH_GITHUB_*` pairs are a first-boot seed only; setting them on
an instance that has already booted adds no provider.

## What a social button actually does

**It never creates an account.** Sign-up through a provider is closed in every profile, so a provider
identity that matches no stored account is refused and no row is written. An invitation comes first,
and the invitation is what sets the password of an account the provider can then open.

**The address the provider asserts decides a first link.** Linking a Google or GitHub identity to an
existing account is the auth library's implicit linking. This build requires the provider to mark the
address verified, and it does not additionally require the stored account's own address to be marked
verified: registration is closed, so every account exists because an administrator invited that
address or because the enterprise connection authorised it, and the invitation or the connection is
the evidence the instance already holds. An account created through an invitation therefore links on
its first verified Google or GitHub sign-in, on the same rule as any other account.

Two things stay refused, and they are the ones that matter:

- **A provider that does not assert the address as verified.** No provider is trusted to skip that
  assertion, so an identity whose address the provider reports as unverified is refused instead of
  linked, whatever account matches.
- **An identity that already belongs to another account.** That identity opens the account it is
  bound to and never becomes a second credential on the account that carries the asserted address.

After a first link the library records the asserted address as verified on that account, and a later
sign-in reuses the identity, so nothing is linked twice.

**Once an identity is linked, the identity is the credential.** That identity row belongs to exactly one
account, so the provider opens the account it is bound to and the address it asserts afterwards neither
moves the identity nor rewrites the stored profile. This path has no conflict refusal of its own: if an
address belongs to one account and the identity is bound to another, the identity decides, which is
what the second bullet above states. The enterprise connection is the path that refuses such a case
with `sso_identity_conflict`; its matrix is in
[Identity providers](/docs/self-hosting/identity-providers/#just-in-time-provisioning-and-linking).

**There is no unlink control.** Neither the account page nor the administration area removes a Google or
GitHub identity from an account; a person who should lose the provider loses the account, or the
provider stops authorising them.

## What a refused person sees

The provider's refusals and the product's refusals happen at different moments, and they look
different:

- **The provider refuses first** — a Google account outside an Internal app, a GitHub account the
  organisation has not approved, a test-user list that does not include the person. Google or GitHub
  shows its own error page, Artiflow is never reached, and nothing is recorded on the instance.
- **Artiflow refuses the sign-in.** The browser comes back to the auth library's own error page at
  `<public origin>/api/auth/error?error=<code>`, which is not a page of this product: it shows the raw
  code, one button back to the site root — which lands on the sign-in page again while nobody is signed
  in — and a link to the library's documentation for that code. There are two codes on this path.
  `signup_disabled` means no stored account matched, and `account_not_linked` means a matching address
  exists but the provider did not assert it as verified, so nothing was linked. Either way the person
  is not signed in, no account, identity or session is written, and the table on `/admin/users` does
  not change.
- **The instance answers instead of the provider.** With an enabled enterprise connection, a social
  sign-in that does not end at an active administrator has its fresh session destroyed and its cookies
  stripped before the response leaves, so the person arrives at the library without a credential and is
  sent to the sign-in page like any visitor. The attempt records one `login.fallback.used` line with
  `outcome: "refused"`. See
  [the sign-in page under a published connection](/docs/self-hosting/identity-providers/#the-sign-in-page-under-a-published-connection).

The page carries the raw code and no sentence this product wrote, so nothing tells the person which of
those cases applied in words they could act on. Only the third case leaves a trace on the instance, as
the one library attempt line named above; a provider refusal and a refused social sign-in record
nothing, and no line of any of them carries an address.

## Verify it works

1. On `/admin/access`, enable one provider with its client id and secret and save. Expect the refreshed
   row with the secret shown as present, the provenance "Set by an administrator", and one
   `access.methods.updated` line in the log.
2. Reload `/login` in a second browser, without restarting anything. The button is there, and
   `GET /api/auth/capabilities` lists the provider in `socialProviders`. A configuration change is a new
   revision, so the running process rebuilds its authentication instance on the next request and swaps
   it atomically — a sign-in already in flight finishes on the configuration it started with, and
   nothing on any page says "restart".
3. Sign in with an account that already carries that identity, or with an account created through an
   invitation. Expect the library, the account's own page, and the method listed on that person's row
   in the users directory.
4. Try an address with no account at all. Expect the library's error page with
   `error=signup_disabled`, and no new row in the directory.
5. Sign in again with the same provider account. Expect the same account and no second method on its
   row: the stored identity was reused.
6. Disable the provider and reload `/login`: the button is gone on the next request, with no restart.
   Read the log; each applied save is one line, and a refused save records nothing.

## What this build does not do

- **No account creation from a provider**, and no way to allow it. Sign-up is closed in every profile.
- **No second way to link.** An identity links only on a provider-verified address that matches a
  stored account: no page, command or administrator action binds or unbinds a provider identity by hand.
- **No Workspace domain or GitHub organisation check.** Internal user type and OAuth App access
  restrictions are the provider's controls, not the product's.
- **No unlink, no identity listing beyond the method names** on the users directory row.
- **No social copy of its own for a refusal.** The library's error page is what a refused person gets.
- **No SAML**, and no social method beyond Google and GitHub.

## Next

[Administer accounts and sign-in](/docs/self-hosting/administration/) covers the Access page, the users
directory and the administration log. [Identity providers](/docs/self-hosting/identity-providers/)
covers the enterprise connection, an alternative to the social methods that binds an identity by its
claim rather than by the address a social provider asserts.
[Recover access](/docs/self-hosting/recovery/) covers what to do when nobody can sign in, and
[Console commands](/docs/reference/console-commands/) lists every operator command.
