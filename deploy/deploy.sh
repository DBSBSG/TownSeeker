#!/usr/bin/env bash
set -euo pipefail

# Hostinger Business managed Node.js deployment.
# GitHub secret: HOSTINGER_API_TOKEN. Variables: HOSTINGER_USERNAME,
# HOSTINGER_DOMAIN. Uploads source archives; no Hostinger Git connection required.
# The target must support managed Node.js builds. Disable any existing Hostinger
# automatic push deployments so GitHub checks gate production releases.
# The reconciler sets HOST, APP_ORIGIN, optional GOOGLE_CLIENT_ID/ADMIN_EMAILS,
# and an isolated DATA_DIRECTORY. Data must
# live in private persistent storage OUTSIDE public_html and hbuilds, with backups.
# This upload helper does not change runtime variables or copy private data.

for name in HOSTINGER_API_TOKEN HOSTINGER_USERNAME HOSTINGER_DOMAIN DEPLOY_SHA; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required configuration: $name" >&2
    exit 1
  fi
done
[[ "$HOSTINGER_USERNAME" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo 'Invalid Hostinger username.' >&2; exit 1; }
[[ "$HOSTINGER_DOMAIN" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$ ]] || { echo 'HOSTINGER_DOMAIN must be a hostname without a scheme or path.' >&2; exit 1; }
[[ "$DEPLOY_SHA" =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid deployment commit.' >&2; exit 1; }
[[ "${DEPLOY_ENVIRONMENT:-}" =~ ^(production|stage|preview-[123])$ ]] || { echo 'Invalid deployment environment.' >&2; exit 1; }
[[ "${DEPLOY_KIND:-app}" =~ ^(app|park)$ ]] || { echo 'Invalid deployment kind.' >&2; exit 1; }

for command in curl jq git mktemp wc awk; do
  command -v "$command" >/dev/null || { echo "Required command not found: $command" >&2; exit 1; }
done

# The trusted reconciler verifies current branch/PR heads and successful checks.
# Never check out or execute the deployed commit on the credentials-bearing runner.
git cat-file -e "$DEPLOY_SHA^{commit}"

api_root="https://developers.hostinger.com/api/hosting/v1"
api="$api_root/accounts/$HOSTINGER_USERNAME/websites/$HOSTINGER_DOMAIN/nodejs"
request() {
  # Do not enable tracing or print API responses: they may contain secrets.
  curl --silent --show-error --fail --connect-timeout 15 --max-time 60 \
    --header "Authorization: Bearer $HOSTINGER_API_TOKEN" \
    --header 'Content-Type: application/json' "$@"
}

umask 077
work_directory=$(mktemp -d)
trap 'rm -f "$work_directory/app.zip" "$work_directory/upload.headers" "$work_directory/package.json" "$work_directory/park.cjs"; rmdir "$work_directory"' EXIT
archive_name="townseeker-${DEPLOY_SHA}-$(date -u +%Y%m%d%H%M%S).zip"
# Allow only runtime source and build inputs, never local data, .env or dependencies.
entry_file=src/js/server/hostinger.js
if [[ "${DEPLOY_KIND:-app}" == park ]]; then
  command -v zip >/dev/null || { echo 'Required command not found: zip' >&2; exit 1; }
  [[ "$DEPLOY_ENVIRONMENT" =~ ^preview-[123]$ ]] || { echo 'Only preview sites may be parked.' >&2; exit 1; }
  printf '%s\n' '{"private":true,"scripts":{"build":"node --check park.cjs"}}' > "$work_directory/package.json"
  printf '%s\n' 'require("node:http").createServer((req,res)=>{res.writeHead(200,{"Content-Type":"text/plain","Cache-Control":"no-store"});res.end("TownSeeker preview unavailable\n");}).listen(process.env.PORT || 3000,"0.0.0.0");' > "$work_directory/park.cjs"
  (cd "$work_directory" && zip -q app.zip package.json park.cjs)
  entry_file=park.cjs
else
  git archive --format=zip --output="$work_directory/app.zip" "$DEPLOY_SHA" -- \
    package.json pnpm-lock.yaml .npmrc tsconfig.json src server \
    data/hunts.example.json data/hunts.schema.json data/user-data.schema.json \
    ':(exclude)src/js' ':(exclude)**/*.test.ts' ':(exclude)src/ts/temp.txt' \
    ':(exclude)**/.env*' ':(exclude)**/*.pem' ':(exclude)**/*.key'
fi
archive_size=$(wc -c < "$work_directory/app.zip" | tr -d '[:space:]')
((archive_size > 0 && archive_size <= 50 * 1024 * 1024)) || { echo 'Source archive must be at most 50 MiB.' >&2; exit 1; }

payload=$(jq -nc --arg username "$HOSTINGER_USERNAME" --arg domain "$HOSTINGER_DOMAIN" \
  '{username:$username,domain:$domain}')
response=$(request --request POST --data "$payload" "$api_root/files/upload-urls")
upload_url=$(jq -er '.url | select(type == "string" and startswith("https://") and (test("[\\r\\n]") | not))' <<< "$response")
auth_key=$(jq -er '.auth_key | select(type == "string" and length > 0 and (test("[\\r\\n]") | not))' <<< "$response")
rest_auth_key=$(jq -er '.rest_auth_key | select(type == "string" and length > 0 and (test("[\\r\\n]") | not))' <<< "$response")
if [[ "${GITHUB_ACTIONS:-}" == true ]]; then
  printf '::add-mask::%s\n' "$upload_url" "$auth_key" "$rest_auth_key"
fi
upload_url="${upload_url%/}/$archive_name?override=true"
upload() {
  curl --silent --show-error --fail --connect-timeout 15 --max-time 300 \
    --header "X-Auth: $auth_key" --header "X-Auth-Rest: $rest_auth_key" \
    --header 'Tus-Resumable: 1.0.0' --output /dev/null "$@" "$upload_url"
}
# Do not retry writes blindly: an interrupted upload must not start a build.
status=$(upload --request POST --header "Upload-Length: $archive_size" \
  --header 'Upload-Offset: 0' --write-out '%{http_code}')
[[ "$status" == 201 ]] || { echo 'Archive upload creation failed.' >&2; exit 1; }
status=$(upload --request PATCH --header 'Content-Type: application/offset+octet-stream' \
  --header 'Upload-Offset: 0' --data-binary "@$work_directory/app.zip" \
  --dump-header "$work_directory/upload.headers" --write-out '%{http_code}')
offset=$(awk 'tolower($1) == "upload-offset:" {gsub("\\r", "", $2); value=$2} END {print value}' "$work_directory/upload.headers")
[[ "$status" == 204 && "$offset" == "$archive_size" ]] || { echo 'Archive upload incomplete; build was not started.' >&2; exit 1; }

payload=$(jq -nc --arg archive "$archive_name" --arg message "TownSeeker $DEPLOY_ENVIRONMENT ${DEPLOY_SHA:0:12} ${DEPLOY_KIND:-app}" \
  --arg entry "$entry_file" \
  '{node_version:22,app_type:"other",root_directory:null,output_directory:null,
    build_script:"build",entry_file:$entry,package_manager:"pnpm",
    source_type:"archive",source_options:{archive_path:$archive,message:$message}}')
response=$(request --request POST --data "$payload" "$api/builds")
uuid=$(jq -er '.uuid | select(type == "string" and test("^[a-zA-Z0-9-]+$"))' <<< "$response")
echo "Hostinger build submitted: $uuid"

for ((attempt=1; attempt<=120; attempt++)); do
  response=$(request "$api/builds/$uuid")
  state=$(jq -er '.state' <<< "$response")
  case "$state" in
    completed)
      # Basic availability check; full data/authentication QA is still required.
      curl --silent --show-error --fail --connect-timeout 15 --max-time 60 \
        --retry 5 --retry-delay 5 --retry-all-errors \
        "https://$HOSTINGER_DOMAIN/" --output /dev/null
      echo "Hostinger deployment completed: https://$HOSTINGER_DOMAIN"
      if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
        printf 'site_url=https://%s\n' "$HOSTINGER_DOMAIN" >> "$GITHUB_OUTPUT"
      fi
      if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
        printf 'Hostinger build %s completed. Site: https://%s\n' "$uuid" "$HOSTINGER_DOMAIN" >> "$GITHUB_STEP_SUMMARY"
      fi
      exit 0
      ;;
    failed)
      echo "Hostinger build $uuid failed. Inspect its build logs in hPanel." >&2
      exit 1
      ;;
    pending|running) sleep 10 ;;
    *) echo "Unexpected Hostinger build state: $state" >&2; exit 1 ;;
  esac
done
echo "Timed out waiting for Hostinger build $uuid; inspect hPanel before retrying." >&2
exit 1
