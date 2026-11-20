# Hunt configuration

## Scope and files

Hunts and their Tasks are stored together in a private JSON configuration file. The sprint integration implements validated file reads/writes and an HTTP API using this format. Access codes, location verification, scoring, hint delivery, and gameplay ordering enforcement remain future work.

- `data/hunts.json` is the empty initial store: `{ "schemaVersion": 1, "hunts": [] }`.
- `data/hunts.example.json` is an illustrative fixture with two embedded Tasks. Its IDs, answers, coordinates, and dates are fictional test data; do not load it as production configuration.
- `data/hunts.schema.json` defines the Draft 2020-12 JSON Schema.
- `src/ts/foundation/types.ts` supplies the corresponding TypeScript interfaces.

Keep real answer-bearing configuration outside the publicly served `src/` directory. The application server enforces hunt owner/contributor authorization and returns player-facing projections without `requiredAnswer` or private owner metadata. Do not expose the raw configuration through a public file endpoint.

## File metadata

| Field           | Type                   | Meaning                                         |
| --------------- | ---------------------- | ----------------------------------------------- |
| `schemaVersion` | Integer, currently `1` | Identifies the format understood by the reader. |
| `hunts`         | Array of Hunts         | All Hunt definitions; an empty array is valid.  |

The initial foundation already reserved version 1. This specifies that initial format before persistence exists. Once stored configuration is in use, incompatible changes require a new version and an explicit migration. Unsupported versions must be rejected rather than silently interpreted.

## Hunt fields

All fields listed below must be present in persisted records.

| Field           | Type                                | Meaning                                                                                              |
| --------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `id`            | Nonblank string                     | Stable Hunt identifier; preserve it when editing.                                                    |
| `name`          | Nonblank string                     | Hunt title; preserves the foundation's existing field name.                                          |
| `description`   | Nonblank string                     | Summary or participant instructions.                                                                 |
| `ownerId`       | Nonblank string                     | Reference to the owner identity, not a copied name or email.                                         |
| `beginsAt`      | UTC date-time string                | Scheduled beginning.                                                                                 |
| `endsAt`        | UTC date-time string or `null`      | Closing time, or no scheduled closing.                                                               |
| `status`        | `draft`, `published`, or `archived` | Publication lifecycle; scheduled activity is determined separately from dates.                       |
| `createdAt`     | UTC date-time string                | Creation timestamp.                                                                                  |
| `updatedAt`     | UTC date-time string                | Last configuration edit, including edits to embedded Tasks.                                          |
| `accessCode`    | `null`                              | Placeholder only. Strings are intentionally rejected until access code functionality is implemented. |
| `taskOrderMode` | `sequential` or `any`               | Intended completion order.                                                                           |
| `tasks`         | Array of Tasks                      | Tasks owned exclusively by this Hunt; an empty array is valid for a new draft.                       |

Use ISO 8601 UTC timestamps ending in `Z`, for example `2026-10-15T14:00:00Z`. Fractional seconds are permitted. `endsAt` must be later than `beginsAt` when provided, and `updatedAt` must not precede `createdAt`.

Recommended creation values: `status: "draft"`, `endsAt: null`, `accessCode: null`, `taskOrderMode: "sequential"`, and `tasks: []`. Set both timestamps to the creation time. The trusted server must determine the owner from the authenticated identity rather than trusting an arbitrary client `ownerId`.

## Task fields

All fields listed below must be present in persisted records.

| Field                 | Type                      | Meaning                                                                                                                                        |
| --------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                  | Nonblank string           | Stable Task identifier, unique within its Hunt.                                                                                                |
| `displayLabel`        | Nonblank string           | Short Task title; preserves the foundation's existing field name.                                                                              |
| `description`         | Nonblank string           | Full question or instructions.                                                                                                                 |
| `requiredAnswer`      | Nonblank string           | Private correct answer; preserves the existing field name.                                                                                     |
| `location`            | Object                    | Contains numeric `latitude` (-90 through 90) and `longitude` (-180 through 180). Coordinates are stored only; no proximity check is performed. |
| `order`               | Integer, at least 1       | Intended position within this Hunt.                                                                                                            |
| `answerCaseSensitive` | Boolean                   | Declares whether case matters when answer comparison is later implemented.                                                                     |
| `hint`                | Nonblank string or `null` | Optional participant help.                                                                                                                     |
| `points`              | Integer, at least 0       | Configured score for this Task.                                                                                                                |

Recommended initial values: `answerCaseSensitive: false`, `hint: null`, and `points: 0`. Assign a unique positive `order` within the Hunt. Store Tasks in ascending order for readability; `order`, rather than array position, is authoritative. In `sequential` mode it defines the intended completion sequence. In `any` mode it defines display order only. Reordering a Task must not replace its ID.

Tasks are embedded and cannot be shared between Hunts. Stored Tasks do not duplicate `huntId`; the containing Hunt determines ownership. The existing player-facing `PlayerTask.huntId` remains available to consumers and must be derived from the parent Hunt when projecting data.

The case-sensitivity flag does not define whitespace or punctuation handling. The answer-validation feature must explicitly agree on those rules.

## Validation and persistence

The schema checks required fields, types, nonblank text, enum values, timestamp format, coordinate bounds, and numeric constraints. Unknown properties are rejected to catch misspelled fields. Enable date-time format checking in the schema validator. JSON Schema defaults are descriptive; validation does not automatically populate missing fields.

The storage implementation additionally enforces unique Hunt IDs, unique Task IDs and order values within each Hunt, and the timestamp relationships described above. These cross-record and cross-field checks are not enforced by this JSON Schema.

The TypeScript interfaces express structure only; validate untrusted JSON at runtime. `HuntInput` and `TaskInput` use the same configuration fields; the creation path supplies initial values before validating and writing the resulting definition. Keep the existing create/retrieve repository methods unchanged.

Use safe atomic writes and serialize concurrent mutations. Report success only after the durable write succeeds. Test retrieval after restart and failed-write handling when runtime persistence is implemented.

Participant identity, progress, submitted answers, earned scores, and completion timestamps belong in separate participant state, not in the Hunt configuration. Only the configured `points` value belongs here.

## Sprint integration: implemented persistence

The sprint integration implements server reads/writes in `src/ts/server/huntStore.ts`, HTTP endpoints in `src/ts/server/server.ts`, and browser calls through `src/ts/features/huntRepository.ts`.

### Run locally

Use Node.js 22 or newer and the pinned pnpm version:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm serve
```

Open `http://127.0.0.1:3000/admin.html` (Hunt Studio) and sign in with Google. The server derives ownership from the verified account and ignores client-supplied `ownerId` values. IDs, timestamps and draft status are generated on the server.

**My hunts** lists only hunts this account owns or contributes to. Its Google-derived creator ID is stable across browsers and devices. Select a hunt to load its tasks; manual hunt-ID entry is no longer needed for editing. Creating a hunt selects it automatically.

Google-authenticated requests send the ID token to the server, which validates it and derives the creator ID as `google-<SHA-256 of Google subject>`. The email is used only for the one-time migration gate and is not stored in hunt ownership. Existing browser-cookie sessions remain temporarily supported for compatibility. When a verified `codepro1012@gmail.com` account opens Hunt Studio, all hunt owners using legacy `browser:<hash>` IDs in that deployment are reassigned to that account. Hunt IDs, tasks, access codes, and player progress are preserved. The operation is idempotent and does not reassign new Google-owned hunts. Each deployment stores its JSON separately, so sign in to each deployment that needs migration.

To collaborate, the hunt owner enters the contributor's Google email under **Contributors**. The private `hunt-contributors.json` store keeps pending invitations separately from active account IDs, for example `{ "schemaVersion": 1, "contributors": { "<hunt-id>": ["google-<account-hash>"] }, "invitations": { "<hunt-id>": ["person@example.com"] } }`. When that person signs in, the server compares the verified Google email, converts matching invitations to stable account IDs, and removes the pending email. Email addresses remain in this private file only while invitations are pending. TownSeeker does not send invitation emails, so the owner must share the site link. Only the owner can invite, cancel, or remove collaborators. The server enforces access on each request; hiding or altering controls in the browser cannot bypass it. Membership persists across application restarts and removal revokes subsequent access immediately.

The Baja Blast migration runs lazily on each environment's first authenticated Hunt Studio session by the named account. It only changes legacy browser owner IDs, never hunt content. Other Google-owned hunts remain with their existing accounts.

By default the server writes the real `data/hunts.json` file. Set `DATA_DIRECTORY` to use another private directory. Missing stores start empty on first save; malformed stores and unsupported schema versions fail without overwriting existing bytes. Every mutation validates the complete hunt, including all embedded tasks. Concurrent mutations in the single application process are queued. Each save writes an exclusive temporary file, synchronizes it, atomically renames it, and synchronizes the containing directory on POSIX. Windows synchronizes the file but does not support this directory sync operation. Failed writes return a failed operation rather than a successful response. Do not run multiple writers against the same files or place them on a filesystem without atomic rename semantics.

Player responses omit required answers and owner metadata. Signed-in player answers and joined hunts update `account-player-progress.json`, keyed by the stable Google account ID and hunt ID, so progress follows the account across browsers on that deployment. The older `player-progress.json` store remains for legacy public-hunt requests.

### HTTP operations

| Method | Path                                           | Result                                                                                |
| ------ | ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| GET    | `/api/admin/session`                           | Return the verified Google creator identity; legacy cookie sessions remain compatible |
| GET    | `/api/admin/hunts`                             | List only owned or contributed hunts                                                  |
| GET    | `/api/admin/hunts/:id/contributors`            | List contributors (owner only)                                                        |
| POST   | `/api/admin/hunts/:id/contributors`            | Invite a collaborator by Google email (owner only)                                    |
| DELETE | `/api/admin/hunts/:id/contributors/:creatorId` | Cancel an invitation or revoke contributor access (owner only)                        |
| GET    | `/api/health`                                  | Application readiness response                                                        |
| POST   | `/api/admin/hunts`                             | Validate and persist a new hunt                                                       |
| GET    | `/api/admin/hunts/:id`                         | Retrieve private hunt/task configuration                                              |
| POST   | `/api/admin/hunts/:id/tasks`                   | Validate and persist an embedded task                                                 |
| GET    | `/api/player/hunts/:id`                        | Public task projection and this browser's completion                                  |
| POST   | `/api/player/hunts/:id/tasks/:taskId/answer`   | Validate an answer and persist completion                                             |

Creator requests use the verified Google ID token when present; legacy browser-cookie sessions remain temporarily available for compatibility. Creating a hunt requires a creator session; reading a private hunt or adding a task additionally requires ownership or contributor membership. Only owners can manage contributor membership. JSON bodies are limited to 64 KiB. API responses use the shared `OperationResult` shape and disable caching. Failures distinguish validation (400), authorization (401/403), missing records/routes (404), and storage failure (500). Server failures include a request ID; structured error logs omit answers, credentials, and request bodies. Static file serving excludes server code and private JSON files.

### Deployment and verification

TownSeeker is maintained by DBSBSG and runs as a Node.js application on Hostinger.
The deployment workflow in `.github/workflows/deploy.yml` runs lint, formatting,
TypeScript, authentication tests, preview orchestration tests, and the browser suite.
Successful checks trigger the trusted reconciler on `main`, which deploys five
separate Hostinger websites: production, stage, and three queued PR preview slots.
The stage PR uses the stage site. Slot labels persist across PR updates; excess
PRs queue in creation order. Closing a PR parks its site, marks the deployment
inactive and releases its slot. Each new assignment uses a fresh data directory;
retired private test data is retained for deliberate offline cleanup.

Configure deployment credentials and runtime settings as described in the
[README](../README.md). `deploy/deploy.sh` submits a managed Node.js build through
Hostinger's API and reports the deployed URL. Application data is managed separately
with the offline [backup and recovery tools](backup_recovery.md).

All runtime JSON belongs in a private, persistent `DATA_DIRECTORY`, outside
`public_html`, build directories, and the static `src` directory. Restrict its
permissions and back it up. One Node.js process owns a data directory; replicas
need a transactional storage design first. A local process restart preserves data,
but an actual Hostinger redeployment/restore must be verified before launch.

The reconciler checks pages, health, Google configuration (or disabled sign-in)
and denied anonymous sessions over HTTPS. The optional live OAuth smoke suite
also checks assets, secure nonce cookies, and invalid/cross-origin login.
Neither creates test hunts or accounts in production. A successful
real Google login, end-to-end hunt completion, and persistent data across an actual
redeployment are separate release checks.

`pnpm test` covers hunt/task validation, persistence and corrupt-store handling,
concurrent writes, owner/contributor/organization permissions, admission controls,
answer privacy, player isolation, navigation, and exports. Tests use temporary
stores and do not use private runtime data from the working tree.

## Google-account task progress (#40)

The new player progress flow sends a Google ID token in the
`Authorization: Bearer <token>` header and uses `credentials: "omit"` for every
account API request. These endpoints never read or set application cookies.
Existing creator sessions, shared login/logout, and anonymous player endpoints
retain their previous cookie behavior. Anonymous progress is not migrated into
Google accounts automatically.

The backend verifies Google's signature, issuer, audience, expiry, verified email,
and authorized party through `google-auth-library`. It derives the storage key
from the verified Google subject, rather than trusting an account ID or email
submitted by the browser. Set `GOOGLE_CLIENT_ID` to the same client ID used by the
existing sign-in integration. Configure it in Hostinger runtime settings; the Node.js application uses the authentication library.

Task completion is stored in the private
`DATA_DIRECTORY/account-player-progress.json`:

```json
{
  "schemaVersion": 1,
  "players": {
    "google-<sha256 of verified Google subject>": {
      "<hunt-id>": ["<completed-task-id>"]
    }
  }
}
```

Correct answers are saved before success is returned. Missing task IDs remain
incomplete. Returning with another valid token for the same Google account
restores the same completion state, including from another browser or device.
The saved-hunt list includes hunts with recorded task progress; opening a hunt
without completing a task does not create a saved-progress record. Corrupt or
unreadable progress, and missing hunt definitions referenced by saved progress,
return errors without inventing completion states or overwriting invalid data.
The existing single-writer, atomic-save, and backup requirements apply.

| Method | Path                                                 | Purpose                                               |
| ------ | ---------------------------------------------------- | ----------------------------------------------------- |
| GET    | `/api/player/account/config`                         | Public Google client ID; no token or cookie required  |
| GET    | `/api/player/account/hunts`                          | Restore this account's hunts with saved progress      |
| GET    | `/api/player/account/hunts/:id`                      | Read tasks and this account's completion state        |
| POST   | `/api/player/account/hunts/:id/tasks/:taskId/answer` | Validate `{ "answer": "..." }` and persist completion |

Except for config, these routes require a valid Google bearer token. They return
`OperationResult` responses with 401 for invalid/expired identity, 400 for invalid
answers, 404 for missing hunts/tasks, and 500 for storage failures. Config returns
503 when Google sign-in is not configured. Responses disable caching; failure
logs retain request IDs without recording tokens or answers.

The player page preserves hunt-ID lookup and uses server progress instead of
local hunt lists. If the token from the existing sign-in expires, or the old
login restores only its cookie session, the player page offers Google
reauthentication without using those cookies for progress. Tokens are held in
`sessionStorage`; display names remain browser-local preferences.

Access-code joining, hunt availability, organization membership, and participation limits are enforced by the account APIs. See Participation controls below.

Tests cover durable completion, restart recovery, fresh browser contexts,
account isolation, incomplete-task preservation, invalid tokens, reauthentication,
storage failures, and cookie omission. Tests inject a local identity verifier;
production has no HTTP or environment switch to bypass Google verification.
Live Google/Hostinger verification and the team's peer reviews remain required before
merge.

## Organizations

Creators can associate an optional organization name (up to 120 characters) with a hunt. Owners and Officers can edit it in the hunt overview. Players see the saved name beside the hunt details when they open or refresh the hunt. Older hunts without an organization remain supported.

## Participation controls

A blank maximum allows unlimited participation. A positive whole number limits active participants; leaving frees a place. Owners and Officers can close or reopen admission in hunt settings. Reopening still enforces capacity. Existing active participants can reopen or refresh their hunts even when full or closed. Players who explicitly leave must satisfy current admission rules to rejoin; their saved task completions are restored when admitted. Capacity checks and membership writes are serialized to prevent concurrent joins from exceeding the limit.

## Issue reports

Players can select Submit Issue below Leave Hunt, choose a task or Hunt in general, and submit up to 4000 characters. Reports store the hunt, task label, description, and creation time without storing the submitter. Owners and Officers can open Issues between Join Hunt and Export results. Unread counts are tracked separately for each administrator; opening the inbox marks only displayed reports read. New reports remain unread until viewed. Reports are persisted in hunt-issues.json under DATA_DIRECTORY and removed with a deleted hunt.

## Hunt types

Create a Hunt offers Traditional Hunt and Kahoot Hunt. Existing hunts default to Traditional Hunt. Kahoot Hunts use a host-controlled lobby and synchronized questions, with optional timers and a leaderboard. See [Kahoot Hunts](kahoot_hunts.md) for hosting, scoring, persistence, and reconnect behavior.
