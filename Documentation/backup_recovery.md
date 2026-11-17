# Backup and recovery

TownSeeker stores private application data in `DATA_DIRECTORY`. Backups are
operator-run maintenance commands. They work without hosting credentials and
require no build or additional dependency.

## Create and verify a backup

1. Stop the Node.js application and prevent automatic restarts or deployments.
2. Create a private backup directory outside the public website and data directory.
3. Run these commands, replacing the example paths with your actual paths:

```sh
pnpm data:backup --data-dir /private/townseeker/data --output /private/backups/daily.townseeker-backup.json --offline
pnpm data:verify --input /private/backups/daily.townseeker-backup.json
```

`--offline` confirms that you stopped the application. The tool cannot stop or
detect the hosting process for you. Keep it stopped throughout the snapshot so
hunts, grants, profiles, and progress come from one consistent point in time.
You can restart it after a successful backup.

The backup contains all eight durable JSON stores and any per-user files under
`users/`. Missing stores are permitted because they are created on first use.
Unknown JSON stores, malformed JSON, unsupported top-level store formats, symlinks,
and empty snapshots are rejected. Each file includes a SHA-256 checksum. The
snapshot limit is 256 MiB, including its JSON envelope. Verification checks the
envelope, allowlisted paths, basic store shape/version, and checksums; application
readers still enforce the full domain rules during the recovery drill.

Authentication sessions and login nonces are excluded so restoring data cannot
revive revoked sessions. Environment files, credentials, schemas, and example data
are also excluded. Backups contain private profile data, answers, and progress.
Files are created with private permissions; on Windows, restrict their ACLs too.
Backups are not encrypted or signed. Keep them in trusted private storage, encrypt
off-host copies through your storage provider, and restrict who can alter them.
Checksums detect corruption, not malicious changes to a backup and its checksums.
Existing backup files are never overwritten; choose a new filename for each run.

## Restore into a new directory

1. Keep the application stopped and retain its current data directory.
2. Verify the backup. Create the destination's parent directory if necessary.
3. Choose a destination directory that does **not** exist, then run:

```sh
pnpm data:restore --input /private/backups/daily.townseeker-backup.json --data-dir /private/townseeker/recovered --offline
```

The tool validates the whole backup before creating restore files. It stages
private files, reserves the new destination exclusively, and cleans up partial
output on a handled failure. Existing directories, including empty ones, are
refused. Keep the application stopped until restore reports success. An abrupt
power loss can leave a partial destination or staging directory: do not use it;
inspect it and retry into a fresh destination.

4. Point a separate local app at the recovered directory. Check representative
   hunts, tasks, organization/contributor permissions, profiles, completed tasks,
   issue reports, and exports. Sign in again; sessions are deliberately absent.
5. After verification, change the production `DATA_DIRECTORY` to the recovered
   absolute path and restart the application. Preserve the previous directory
   until the recovery has been accepted.

## Retention and drills

Choose a backup frequency and retention period based on how much recent data you
can afford to lose. Copy verified backups off the hosting machine and routinely
practice restoring them into a fresh local directory. These commands do not
schedule backups, delete old snapshots, or change hosting settings.

`pnpm exec playwright test tests/dataBackup.test.ts` exercises round-trip recovery
through the production data readers, integrity failures, path rejection, private
permissions, CLI options, and concurrent restores. Verify actual Hostinger storage
persistence and backup scheduling before launch.
