# TownSeeker development tools

DBSBSG maintains [TownSeeker](https://github.com/DBSBSG/TownSeeker) in GitHub.
Use issues for planned work and pull requests for review.

## Runtime and dependencies

- Node.js 22.18 or newer.
- pnpm 10.33.0, as declared in `package.json`.
- TypeScript for browser and server code.
- Google Identity Services and `google-auth-library` for sign-in.
- Hostinger Business managed Node.js hosting for deployment.

Run `pnpm install --frozen-lockfile`, `pnpm build`, and `pnpm serve`.
Rebuild after TypeScript changes or use `pnpm build:watch`. Generated `src/js`
files are build outputs, not source changes.

## Validation

- `pnpm lint` checks application TypeScript.
- `pnpm format:check` checks the repository's configured formatting scope.
- Use Prettier 3.9.10 on every changed supported file before committing.
- `pnpm check:admin` and `pnpm test:admin` check authentication.
- `pnpm exec playwright install chromium` installs the test browser.
- `pnpm test` runs API, persistence, and browser tests.

The deployment workflow runs quality checks for PRs, `stage`, and feature branches.
A trusted reconciler deploys production, stage, and three queued PR preview slots
from uploaded source archives. Stage never consumes a PR slot. Closing a PR parks
its preview and releases the slot to the next queued PR. GitHub deployment statuses
provide links. Run `node --test tests/previewDeployment.test.mjs` for queue and
deployment orchestration tests. See the README for the five hostname variables.
Live HTTP smoke checks run after a successful Hostinger deployment. Local tests
use isolated stores and identity fixtures; they do not prove a successful live
Google login or persistence across a Hostinger redeployment.

## Configuration and operations

See the [README](../README.md) for authentication variables, deployment
credentials, private persistent storage, and remaining live verification.
Keep secrets in Hostinger runtime settings or GitHub Actions secrets.
The connected GitHub organization is DBSBSG.

Diagrams may use Mermaid or another tool the team chooses. No Docker setup,
paid diagramming service is required by the current development or deployment
commands.
