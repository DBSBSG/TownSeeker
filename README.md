# TownSeeker

TownSeeker is a scavenger-hunt platform by DBSBSG for communities, campuses, and local businesses.

Source: [DBSBSG/TownSeeker](https://github.com/DBSBSG/TownSeeker).

TownSeeker supports creating hunts, defining tasks with answers and coordinates, saving and retrieving server-side JSON configuration, and displaying player tasks with persisted completion. Google sign-in links hunt ownership, contributor access, player profiles, and progress to stable account identities. Access-code joining is available to signed-in players.

## Local development

Use Node.js 22.18 or newer and pnpm 10.33.0. `.nvmrc` selects Node.js 22;
dependency installation enforces the minimum Node.js version.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Open `http://127.0.0.1:3000/`. Real Google browser sign-in requires the authentication variables and HTTPS described below; automated tests use isolated identity fixtures. After signing in, use Hunt Studio to create hunts and tasks or reopen hunts you own or contribute to.

For local configuration, copy `.env.example` to `.env` and fill in the deployment
values. `pnpm start` loads `.env` when present; existing environment variables
take precedence. `pnpm serve` is an alias for the same startup command. Build
TypeScript before starting. On Hostinger, the deployment reconciler manages
runtime variables as described below.

To collaborate, the hunt owner enters the contributor's Google email under **Contributors**. The invite becomes active when that person signs in with the same verified email. TownSeeker does not send an email, so share the site link with them. Contributors can add tasks; only the owner can grant, cancel, or remove access.

Hunts are owned by the signed-in Google account. Each deployment has its own private `DATA_DIRECTORY`. Runtime JSON files store hunt definitions, contributor grants, profiles, and progress separately.

```sh
pnpm lint
pnpm format:check
pnpm exec playwright install --with-deps chromium
pnpm test
```

See [Hunt configuration](Documentation/hunt_configuration.md) for the JSON format, API, persistence guarantees and recovery limitations. Hostinger deployment requires a Node.js application and private persistent storage. Build, test, peer review, deployment, and deployed verification must succeed before release.

## Hostinger deployment environments

GitHub Actions uploads source archives through the Hostinger API; Hostinger Git
import is not required. Five distinct managed Node.js websites provide stable URLs:

| Environment | Source                                | GitHub Actions variable      |
| ----------- | ------------------------------------- | ---------------------------- |
| Production  | `main`                                | `HOSTINGER_DOMAIN`           |
| Stage       | `stage`, including its PR into `main` | `HOSTINGER_STAGE_DOMAIN`     |
| Preview 1   | Assigned PR                           | `HOSTINGER_PREVIEW_1_DOMAIN` |
| Preview 2   | Assigned PR                           | `HOSTINGER_PREVIEW_2_DOMAIN` |
| Preview 3   | Assigned PR                           | `HOSTINGER_PREVIEW_3_DOMAIN` |

Create five websites on the Business plan and set those repository variables to
their hostnames, without `https://` or paths. Set `HOSTINGER_USERNAME` to the
hosting account username, and store `HOSTINGER_API_TOKEN` as a repository secret.
Missing or duplicate hostnames stop reconciliation before hosting changes.
Existing automatic Hostinger Git deployments must be disabled.

`.github/workflows/deploy.yml` runs checks without deployment credentials.
After successful checks, `.github/workflows/destroy-pr.yml` reconciles all five
environments using trusted scripts from `main`. It also runs on same-repository
PR closure or manual dispatch. Updates are serialized. Only current successful
checks with verification, lint and E2E jobs can release an application. Fork PRs
are tested but never receive deployment credentials or preview slots.

Preview slots are assigned in PR creation order. Existing assignments stay
stable; additional PRs get the `Queued` label. The `stage` to `main` PR uses the
stage site without consuming a slot. GitHub deployment statuses provide the
environment URL; run summaries list deployed links and queued PRs. A PR must
have current successful checks before its slot deploys. Closing a PR parks its
site, marks its deployment inactive, releases its label and deploys the next
checked queued PR.

The reconciler manages `HOST`, `APP_ORIGIN`, `DATA_DIRECTORY`, and optional
`GOOGLE_CLIENT_ID` and `ADMIN_EMAILS` runtime values. Set the latter two as
repository variables when ready; leave them unset to keep Google sign-in disabled.
It refuses to replace unknown masked runtime keys or discard existing Google/admin
settings whose real values are not supplied. Do not configure extra runtime keys
without extending the managed configuration first.

Production and stage use `/home/USERNAME/townseeker-data/production` and
`/home/USERNAME/townseeker-data/stage`. Each new preview assignment uses a fresh
private directory under `/home/USERNAME/townseeker-data/preview-N/`; updates to the
same assignment preserve it. Slot reuse never gives a PR its predecessor's data.
Retired preview directories are retained offline for deliberate cleanup, not
deleted by PR workflows. These directories separate application data; websites
under one hosting account are not a security sandbox for hostile code.
Only trusted organization code should be deployed there. Verify private-directory
permissions, backups and single-process release behavior before production use.

Run `node --test tests/previewDeployment.test.mjs` to check allocation, queuing,
release ordering, source verification, isolation and masked-setting protection.
The reconciler verifies live pages, health, denied anonymous sessions and either
configured Google identity or disabled sign-in. The detailed live OAuth smoke
suite below remains available once Google configuration is ready.

## Google sign-in and administrative access

Authentication runs in the same Node.js process as the hunt application. It uses
Google Identity Services and `google-auth-library`.

The reconciler sets these runtime environment variables in Hostinger:

| Variable           | Value                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID` | The public Google OAuth web client ID authorized for this deployment.                                          |
| `APP_ORIGIN`       | Exact HTTPS site origin, such as `https://townseeker.example`, without a trailing slash, credentials, or path. |
| `ADMIN_EMAILS`     | Comma-separated verified Google emails allowed administrator access. Empty grants no administrator access.     |
| `DATA_DIRECTORY`   | Absolute path to private persistent storage outside the website document root and Hostinger build directories. |
| `HOST`             | `0.0.0.0` for Hostinger.                                                                                       |

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
source control.

Use the offline `pnpm data:backup`, `pnpm data:verify`, and `pnpm data:restore`
commands described in [Backup and recovery](Documentation/backup_recovery.md).
Restore into a new directory and verify it before changing `DATA_DIRECTORY`.
Login sessions are excluded from backups; users sign in after a restore.

**Run one Node.js application process per data directory.** The file store
serializes concurrent operations within that process, including consuming a nonce
exactly once. Multiple processes, replicas, or overlapping releases sharing this
directory require a transactional session database before enabling them. Persistent
storage and Hostinger's process/deployment behavior must be verified before launch.

The host-only `__Host-townseeker-session` cookie uses
`HttpOnly; Secure; SameSite=Strict; Path=/`. Sessions expire after one hour.
The login nonce cookie is also browser-bound and secure. Google signature,
issuer, audience, expiry, verified email, authorized party, and nonce are checked
on sign-in. Secure cookies require HTTPS for real browser login; local HTTP tests
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
Hunt ownership, organization roles, and player bearer-token authorization have
their own access controls.

### Verification

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check:admin
pnpm test:admin
pnpm exec playwright test tests/authentication.test.ts
```

Tests cover Google verification rules, HTTP routing, nonce replay and
concurrency, session persistence across a separate process restart, role changes,
logout revocation, expiry, malformed requests, and corrupt storage.

The post-deployment HTTP smoke suite runs with `BASE_URL` and the expected public
`GOOGLE_CLIENT_ID`. It verifies pages/assets, auth configuration, unauthenticated
access denial, and invalid/cross-origin login rejection. A real successful Google
login and persistence across an actual Hostinger redeployment
still require deployed verification.
