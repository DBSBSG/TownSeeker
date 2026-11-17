# TownSeeker

TownSeeker is a scavenger-hunt platform by DBSBSG for communities, campuses, and local businesses.

Source: [DBSBSG/TownSeeker](https://github.com/DBSBSG/TownSeeker).

The integrated sprint supports creating hunts, defining tasks with answers and coordinates, saving and retrieving server-side JSON configuration, and displaying player tasks with persisted completion. Google sign-in links hunt ownership, contributor access, player profiles, and progress to stable account identities. Access-code joining is available to signed-in players.

## Local development

TownSeeker uses its own logo, favicon, browser-storage keys, event names, export
labels, and authentication cookies. This rebrand signs out existing browser
sessions; sign in again to retrieve saved server-side profiles and progress.
The configured legacy ownership email and saved hunt identifiers are unchanged.

Use Node.js 22+ and pnpm 10.33.0.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm serve
```

Open `http://127.0.0.1:3000/`. AWS access is not needed. Real Google browser sign-in requires the authentication variables and HTTPS described below; automated tests use isolated identity fixtures. After signing in, use Hunt Studio to create hunts and tasks or reopen hunts you own or contribute to.

To collaborate, the hunt owner enters the contributor's Google email under **Contributors**. The invite becomes active when that person signs in with the same verified email. TownSeeker does not send an email, so share the site link with them. Contributors can add tasks; only the owner can grant, cancel, or remove access.

Existing hunts owned by temporary browser IDs are reassigned to Baja Blast's verified Google account (`codepro1012@gmail.com`) the first time that account opens Hunt Studio in each deployment. The migration updates only legacy `browser:` ownership IDs; hunt IDs, tasks, codes, and progress remain unchanged. Each deployment has its own private `DATA_DIRECTORY`, so sign in at each environment that contains hunts to migrate. New hunts are owned by the signed-in Google account. Runtime JSON files store hunt definitions, contributor grants, profiles, and progress separately.

```sh
pnpm lint
pnpm format:check
pnpm exec playwright install --with-deps chromium
pnpm test
```

See [Hunt configuration](Documentation/hunt_configuration.md) for the JSON format, API, persistence guarantees and recovery limitations. Hostinger deployment requires a Node.js application and private persistent storage. Build, test, peer review, deployment, and deployed verification must succeed before release.

## Google sign-in and administrative access

Authentication runs in the same Node.js process as the hunt application. It uses
Google Identity Services and `google-auth-library`; AWS Lambda, API Gateway,
DynamoDB, and AWS credentials are not required.

Set these runtime environment variables in Hostinger:

| Variable           | Value                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID` | The public Google OAuth web client ID; keep the existing value until the new account is ready.                 |
| `APP_ORIGIN`       | Exact HTTPS site origin, such as `https://townseeker.example`, without a trailing slash, credentials, or path. |
| `ADMIN_EMAILS`     | Comma-separated verified Google emails allowed administrator access. Empty grants no administrator access.     |
| `DATA_DIRECTORY`   | Absolute path to private persistent storage outside the website document root and Hostinger build directories. |
| `HOST`             | `0.0.0.0` for Hostinger.                                                                                       |

`ADMIN_ORIGIN` is accepted as a compatibility fallback when `APP_ORIGIN` is absent.
Missing Google configuration or an invalid origin makes authentication fail closed
with 503. Restart the application after changing runtime variables. The Google
web client must authorize the same HTTPS origin; this popup flow needs no client
secret. See [Google's setup guide](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid).

Authentication sessions and five-minute login nonces live in
`DATA_DIRECTORY/auth-sessions.json`. Session tokens are stored only as SHA-256
lookup keys. Files are written atomically with private permissions; expiry is
checked on every read and expired records are pruned on writes. Corrupt files
are preserved and authentication fails closed rather than resetting them.
Back up the private data directory, restrict access to it, and exclude it from
source control. Old AWS sessions are not imported; users sign in again.

**Run one Node.js application process per data directory.** The file store
serializes concurrent operations within that process, including consuming a nonce
exactly once. Multiple processes, replicas, or overlapping releases sharing this
directory require a transactional session database before enabling them. Persistent
storage and Hostinger's process/deployment behavior must be verified before launch.

The host-only `__Host-townseeker-session` cookie uses
`HttpOnly; Secure; SameSite=Strict; Path=/`. Sessions expire after one hour.
The login nonce cookie is also browser-bound and secure. Google signature,
issuer, audience, expiry, verified email, authorized party, and nonce checks are
preserved. Secure cookies require HTTPS for real browser login; local HTTP tests
send fixture cookies explicitly and do not represent a browser OAuth login.

| Method | Path                      | Behavior                                                          |
| ------ | ------------------------- | ----------------------------------------------------------------- |
| GET    | `/api/auth/config`        | Public client ID and one-use login nonce.                         |
| POST   | `/api/auth/login`         | Verify the Google credential and issue a new application session. |
| GET    | `/api/auth/session`       | Current identity, expiry, and role.                               |
| POST   | `/api/auth/logout`        | Revoke the session and clear its cookie.                          |
| GET    | `/api/admin/capabilities` | Verify administrator access.                                      |

Writes require the configured exact request Origin. Responses use `no-store`.
Administrator roles are recalculated from `ADMIN_EMAILS` on every session lookup;
changing the list and restarting the app changes existing sessions' privileges.
Hunt ownership, organization roles, the legacy ownership email, and player bearer
token authorization remain separate and unchanged.

### Verification

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check:admin
pnpm test:admin
pnpm exec playwright test tests/authentication.test.ts
```

Tests cover the existing Google verification rules, HTTP routing, nonce replay and
concurrency, session persistence across a separate process restart, role changes,
logout revocation, expiry, malformed requests, and corrupt storage.

The post-deployment HTTP smoke suite runs with `BASE_URL` and the expected public
`GOOGLE_CLIENT_ID`. It verifies pages/assets, auth configuration, unauthenticated
access denial, and invalid/cross-origin login rejection. A real successful Google
login with the new account and persistence across an actual Hostinger redeployment
still require deployed verification.
