# TownSeeker application foundation

TownSeeker is a DBSBSG scavenger-hunt application for communities, campuses, and
local businesses. The application includes shared navigation and styling,
administrator and player interfaces, account sign-in, organizations, hunts,
tasks, participation controls, issue reports, and result exports.

## Structure

| Area                                | Source                                                                |
| ----------------------------------- | --------------------------------------------------------------------- |
| Landing page and Google sign-in     | `src/index.html`, `src/ts/admin.ts`                                   |
| Hunt Studio                         | `src/admin.html`, `src/ts/features/`                                  |
| Player experience                   | `src/player.html`, `src/ts/features/displayTasks.ts`                  |
| Shared contracts and bootstrap      | `src/ts/foundation/`                                                  |
| Node.js HTTP server and persistence | `src/ts/server/`                                                      |
| Authentication                      | `src/ts/server/auth.ts`, `src/ts/server/authSessionStore.ts`          |
| Brand images                        | `src/assets/townseeker-logo.png`, `src/assets/townseeker-favicon.png` |
| Automated verification              | `tests/`, `src/server/admin.test.ts`                                  |

Feature modules receive their root element and service dependencies. Keep DOM
queries within the supplied root, and coordinate changes to shared contracts,
HTML, bootstrap, and CSS. Browser events and storage keys use the `townseeker`
namespace. The logo is an image asset; do not recreate or duplicate its wordmark
as adjacent text.

## Run and verify

Use the commands in the [README](../README.md) and [tools guide](tools.md).
Build TypeScript before serving the application. Browser login requires the
configured Google client, exact site origin, and HTTPS. Tests inject identity
fixtures without enabling a production authentication bypass.

## Contracts and storage

`OperationResult` represents successful operations and validation,
authorization, missing-resource, network, and storage failures. Server validation
is authoritative. Never return required answers or private ownership data in
player projections.

Hunt definitions, grants, organizations, profiles, progress, issue reports,
game state, and authentication sessions use separate private JSON stores under
`DATA_DIRECTORY`. File mutations are serialized in one Node.js process and use
atomic writes. Do not put runtime data in the public static directory or a
replaceable build directory. See [hunt configuration](hunt_configuration.md) for
API details and storage limitations.

## Delivery

Feature branches start from `stage` and are reviewed into `stage`. Production
releases reach `main` through the team's review process. GitHub checks builds,
formatting, types, authentication, APIs, and browser behavior. Hostinger deploys
the Node.js application after those checks pass.

Actual Google login and deployment persistence must be verified on Hostinger
before release. See [backup and recovery](backup_recovery.md) for offline data
protection and restore drills.
