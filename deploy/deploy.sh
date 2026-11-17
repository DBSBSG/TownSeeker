#!/usr/bin/env bash
set -euo pipefail

# Hostinger Business managed Node.js deployment, replacing AWS and FTP uploads.
# GitHub secret: HOSTINGER_API_TOKEN. Variables: HOSTINGER_USERNAME,
# HOSTINGER_DOMAIN, HOSTINGER_GIT_INSTALLATION_UUID (Hostinger Git installation).
# Create the Node.js website and connect this repository in hPanel first.
# Disable automatic push deployments so GitHub checks gate production releases.
# Set HOST=0.0.0.0, GOOGLE_CLIENT_ID, and DATA_DIRECTORY in hPanel. Data must
# live in private persistent storage OUTSIDE public_html and hbuilds, with backups.
# Existing environment variables are preserved. This does not transfer old data
# or replace the separate AWS Lambda/DynamoDB authentication implementation.

for name in HOSTINGER_API_TOKEN HOSTINGER_USERNAME HOSTINGER_DOMAIN HOSTINGER_GIT_INSTALLATION_UUID GITHUB_REPOSITORY GITHUB_SHA; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required configuration: $name" >&2
    exit 1
  fi
done
[[ "$HOSTINGER_USERNAME" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo 'Invalid Hostinger username.' >&2; exit 1; }
[[ "$HOSTINGER_DOMAIN" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$ ]] || { echo 'HOSTINGER_DOMAIN must be a hostname without a scheme or path.' >&2; exit 1; }
[[ "${GITHUB_REF:-}" == refs/heads/main ]] || { echo 'Production deployment requires main.' >&2; exit 1; }

for command in curl jq git; do
  command -v "$command" >/dev/null || { echo "Required command not found: $command" >&2; exit 1; }
done

# Hostinger clones the branch head. Skip obsolete workflow runs.
head_sha=$(git ls-remote origin refs/heads/main | cut -f1)
if [[ "$head_sha" != "$GITHUB_SHA" ]]; then
  echo 'A newer main commit exists; skipping this obsolete deployment.'
  exit 0
fi

api="https://developers.hostinger.com/api/hosting/v1/accounts/$HOSTINGER_USERNAME/websites/$HOSTINGER_DOMAIN/nodejs"
request() {
  # Do not enable tracing or print API responses: they may contain secrets.
  curl --silent --show-error --fail --connect-timeout 15 --max-time 60 \
    --header "Authorization: Bearer $HOSTINGER_API_TOKEN" \
    --header 'Content-Type: application/json' "$@"
}

payload=$(jq -nc \
  --arg owner "${GITHUB_REPOSITORY%%/*}" \
  --arg repository "${GITHUB_REPOSITORY#*/}" \
  --arg installation "$HOSTINGER_GIT_INSTALLATION_UUID" \
  '{node_version:22,app_type:"other",root_directory:null,output_directory:null,
    build_script:"build",entry_file:"src/js/server/server.js",package_manager:"pnpm",
    source_type:"git",source_options:{owner:$owner,repository:$repository,
    branch:"main",installation_uuid:$installation}}')
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
