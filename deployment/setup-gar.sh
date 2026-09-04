#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEANUP_POLICY="${SCRIPT_DIR}/gar-cleanup-policy.json"

PROJECT_ID=""
LOCATION=""
REPOSITORY_ID=""
OUTPUT_PATH="${HOME:?HOME must be set}/techulus-gar.env"

TEMP_DIR=""
OUTPUT_TEMP=""
AGENT_KEY_FILE=""
ADMIN_KEY_FILE=""
AGENT_KEY_ID=""
ADMIN_KEY_ID=""
KEYS_COMMITTED="false"

usage() {
    cat <<'EOF'
Provision Google Artifact Registry for Techulus Cloud.

Usage:
  setup-gar.sh --project PROJECT_ID --location LOCATION \
    --repository REPOSITORY_ID [--output PATH]

Required:
  --project       Google Cloud project ID
  --location      GAR location, for example us-central1
  --repository    GAR Docker repository ID, for example techulus-images

Optional:
  --output        Credential environment file
                  (default: $HOME/techulus-gar.env)
  -h, --help      Show this help

Run this script from Google Cloud Shell or a trusted workstation with an
authenticated gcloud CLI. It creates two fresh service-account keys and never
prints their contents.
EOF
}

fail() {
    echo "Error: $*" >&2
    exit 1
}

require_option_value() {
    local option="$1"
    local value="${2:-}"

    if [[ -z "$value" || "$value" == --* ]]; then
        fail "${option} requires a value"
    fi
}

while (($# > 0)); do
    case "$1" in
        --project)
            require_option_value "$1" "${2:-}"
            PROJECT_ID="$2"
            shift 2
            ;;
        --project=*)
            PROJECT_ID="${1#*=}"
            shift
            ;;
        --location)
            require_option_value "$1" "${2:-}"
            LOCATION="$2"
            shift 2
            ;;
        --location=*)
            LOCATION="${1#*=}"
            shift
            ;;
        --repository)
            require_option_value "$1" "${2:-}"
            REPOSITORY_ID="$2"
            shift 2
            ;;
        --repository=*)
            REPOSITORY_ID="${1#*=}"
            shift
            ;;
        --output)
            require_option_value "$1" "${2:-}"
            OUTPUT_PATH="$2"
            shift 2
            ;;
        --output=*)
            OUTPUT_PATH="${1#*=}"
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            usage >&2
            fail "unknown option: $1"
            ;;
    esac
done

[[ -n "$PROJECT_ID" ]] || fail "--project is required"
[[ -n "$LOCATION" ]] || fail "--location is required"
[[ -n "$REPOSITORY_ID" ]] || fail "--repository is required"
[[ -n "$OUTPUT_PATH" ]] || fail "--output cannot be empty"

[[ "$PROJECT_ID" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] ||
    fail "invalid Google Cloud project ID: ${PROJECT_ID}"
[[ "$LOCATION" =~ ^[a-z][a-z0-9-]*$ ]] ||
    fail "invalid GAR location: ${LOCATION}"
[[ "$REPOSITORY_ID" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] ||
    fail "invalid GAR repository ID: ${REPOSITORY_ID}"

for dependency in gcloud jq base64 tr mktemp; do
    command -v "$dependency" >/dev/null 2>&1 || fail "required command not found: ${dependency}"
done

[[ -f "$CLEANUP_POLICY" ]] || fail "cleanup policy not found: ${CLEANUP_POLICY}"
jq -e 'type == "array" and length > 0' "$CLEANUP_POLICY" >/dev/null ||
    fail "cleanup policy is not a non-empty JSON array: ${CLEANUP_POLICY}"

[[ ! -e "$OUTPUT_PATH" && ! -L "$OUTPUT_PATH" ]] ||
    fail "output already exists; move or remove it first: ${OUTPUT_PATH}"

OUTPUT_DIR="$(dirname "$OUTPUT_PATH")"
[[ -d "$OUTPUT_DIR" ]] || fail "output directory does not exist: ${OUTPUT_DIR}"
[[ -w "$OUTPUT_DIR" ]] || fail "output directory is not writable: ${OUTPUT_DIR}"

ACTIVE_ACCOUNT="$(
    gcloud auth list \
        --filter='status:ACTIVE' \
        --format='value(account)' \
        --limit=1
)"
[[ -n "$ACTIVE_ACCOUNT" ]] ||
    fail "gcloud has no active account; run 'gcloud auth login' or use Google Cloud Shell"

gcloud projects describe "$PROJECT_ID" --format='value(projectId)' >/dev/null ||
    fail "active account cannot access project ${PROJECT_ID}"

GAR_REPOSITORY="${LOCATION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY_ID}"
AGENT_SERVICE_ACCOUNT="techulus-agent@${PROJECT_ID}.iam.gserviceaccount.com"
ADMIN_SERVICE_ACCOUNT="techulus-control-plane@${PROJECT_ID}.iam.gserviceaccount.com"

cat <<EOF

Techulus GAR bootstrap
  Active account: ${ACTIVE_ACCOUNT}
  Project:        ${PROJECT_ID}
  Repository:     ${GAR_REPOSITORY}
  Output:         ${OUTPUT_PATH}

This will create or update GAR resources and create two fresh, non-expiring
service-account keys. Existing keys will not be changed.
EOF

read -r -p "Type the project ID to continue: " confirmation
[[ "$confirmation" == "$PROJECT_ID" ]] || fail "confirmation did not match; no changes made"

revoke_key() {
    local key_id="$1"
    local service_account="$2"

    [[ -n "$key_id" ]] || return 0

    echo "Revoking newly created key ${key_id} for ${service_account}..." >&2
    if ! gcloud iam service-accounts keys delete "$key_id" \
        --iam-account="$service_account" \
        --project="$PROJECT_ID" \
        --quiet >/dev/null 2>&1; then
        echo "Warning: could not revoke key ${key_id}; delete it manually." >&2
    fi
}

key_id_from_file() {
    local key_file="$1"

    if [[ -f "$key_file" ]]; then
        jq -r '.private_key_id // empty' "$key_file" 2>/dev/null || true
    fi
}

cleanup() {
    local status=$?

    trap - EXIT INT TERM

    if [[ $status -ne 0 && "$KEYS_COMMITTED" != "true" ]]; then
        [[ -n "$ADMIN_KEY_ID" ]] || ADMIN_KEY_ID="$(key_id_from_file "$ADMIN_KEY_FILE")"
        [[ -n "$AGENT_KEY_ID" ]] || AGENT_KEY_ID="$(key_id_from_file "$AGENT_KEY_FILE")"
        revoke_key "$ADMIN_KEY_ID" "$ADMIN_SERVICE_ACCOUNT"
        revoke_key "$AGENT_KEY_ID" "$AGENT_SERVICE_ACCOUNT"
    fi

    [[ -z "$OUTPUT_TEMP" ]] || rm -f -- "$OUTPUT_TEMP"
    [[ -z "$TEMP_DIR" ]] || rm -rf -- "$TEMP_DIR"

    if [[ $status -ne 0 ]]; then
        cat >&2 <<'EOF'
GAR setup failed. For permission errors, verify that the operator can enable
APIs, administer Artifact Registry repositories and IAM, create service
accounts, and create service-account keys. If key creation is prohibited, ask
your organization administrator about iam.disableServiceAccountKeyCreation.
EOF
    fi

    exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "Enabling Google Cloud APIs..."
gcloud services enable \
    artifactregistry.googleapis.com \
    iam.googleapis.com \
    --project="$PROJECT_ID" \
    --quiet

echo "Provisioning Docker repository..."
if repository_json="$(
    gcloud artifacts repositories describe "$REPOSITORY_ID" \
        --project="$PROJECT_ID" \
        --location="$LOCATION" \
        --format=json 2>/dev/null
)"; then
    repository_format="$(jq -r '.format // empty' <<<"$repository_json")"
    repository_mode="$(jq -r '.mode // "STANDARD_REPOSITORY"' <<<"$repository_json")"
    [[ "$repository_format" == "DOCKER" ]] ||
        fail "existing repository is ${repository_format:-unknown}, not DOCKER"
    [[ "$repository_mode" == "STANDARD_REPOSITORY" ]] ||
        fail "existing repository is ${repository_mode}, not STANDARD_REPOSITORY"
    echo "Using existing standard Docker repository."
else
    gcloud artifacts repositories create "$REPOSITORY_ID" \
        --project="$PROJECT_ID" \
        --location="$LOCATION" \
        --repository-format=docker \
        --description="Techulus Cloud source images" \
        --quiet
fi

ensure_service_account() {
    local account_id="$1"
    local account_email="$2"
    local display_name="$3"

    if gcloud iam service-accounts describe "$account_email" \
        --project="$PROJECT_ID" \
        --format='value(email)' >/dev/null 2>&1; then
        echo "Using existing service account ${account_email}."
    else
        gcloud iam service-accounts create "$account_id" \
            --project="$PROJECT_ID" \
            --display-name="$display_name" \
            --quiet
    fi
}

echo "Provisioning service accounts..."
ensure_service_account \
    "techulus-agent" \
    "$AGENT_SERVICE_ACCOUNT" \
    "Techulus agents"
ensure_service_account \
    "techulus-control-plane" \
    "$ADMIN_SERVICE_ACCOUNT" \
    "Techulus control plane"

echo "Granting repository-scoped access..."
gcloud artifacts repositories add-iam-policy-binding "$REPOSITORY_ID" \
    --project="$PROJECT_ID" \
    --location="$LOCATION" \
    --member="serviceAccount:${AGENT_SERVICE_ACCOUNT}" \
    --role="roles/artifactregistry.writer" \
    --format=none \
    --quiet
gcloud artifacts repositories add-iam-policy-binding "$REPOSITORY_ID" \
    --project="$PROJECT_ID" \
    --location="$LOCATION" \
    --member="serviceAccount:${ADMIN_SERVICE_ACCOUNT}" \
    --role="roles/artifactregistry.repoAdmin" \
    --format=none \
    --quiet

echo "Checking cleanup policies..."
existing_cleanup_policies="$(
    gcloud artifacts repositories list-cleanup-policies "$REPOSITORY_ID" \
        --project="$PROJECT_ID" \
        --location="$LOCATION" \
        --format='value(name)'
)"
if [[ -z "$existing_cleanup_policies" ]]; then
    gcloud artifacts repositories set-cleanup-policies "$REPOSITORY_ID" \
        --project="$PROJECT_ID" \
        --location="$LOCATION" \
        --policy="$CLEANUP_POLICY" \
        --dry-run \
        --quiet
    echo "Installed the Techulus cleanup policy in dry-run mode."
else
    echo "Existing cleanup policies were preserved. Review them before continuing."
fi

umask 077
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/techulus-gar.XXXXXX")"
chmod 700 "$TEMP_DIR"
AGENT_KEY_FILE="${TEMP_DIR}/agent.json"
ADMIN_KEY_FILE="${TEMP_DIR}/admin.json"

echo "Creating fresh service-account keys..."
gcloud iam service-accounts keys create "$AGENT_KEY_FILE" \
    --iam-account="$AGENT_SERVICE_ACCOUNT" \
    --project="$PROJECT_ID" \
    --key-file-type=json \
    --quiet >/dev/null
AGENT_KEY_ID="$(jq -er '.private_key_id | select(type == "string" and length > 0)' "$AGENT_KEY_FILE")"

gcloud iam service-accounts keys create "$ADMIN_KEY_FILE" \
    --iam-account="$ADMIN_SERVICE_ACCOUNT" \
    --project="$PROJECT_ID" \
    --key-file-type=json \
    --quiet >/dev/null
ADMIN_KEY_ID="$(jq -er '.private_key_id | select(type == "string" and length > 0)' "$ADMIN_KEY_FILE")"

AGENT_KEY_BASE64="$(base64 < "$AGENT_KEY_FILE" | tr -d '\n')"
ADMIN_KEY_BASE64="$(base64 < "$ADMIN_KEY_FILE" | tr -d '\n')"

OUTPUT_TEMP="$(mktemp "${OUTPUT_PATH}.tmp.XXXXXX")"
cat > "$OUTPUT_TEMP" <<EOF
GAR_REPOSITORY=${GAR_REPOSITORY}
GAR_AGENT_KEY_BASE64=${AGENT_KEY_BASE64}
GAR_ADMIN_KEY_BASE64=${ADMIN_KEY_BASE64}
EOF
chmod 600 "$OUTPUT_TEMP"

# Keep the output move and rollback-state update indivisible with respect to
# interactive interruption. A failed no-clobber move still rolls the keys back.
trap '' INT TERM
mv -n -- "$OUTPUT_TEMP" "$OUTPUT_PATH"
[[ ! -e "$OUTPUT_TEMP" ]] ||
    fail "output was created by another process; it was not overwritten: ${OUTPUT_PATH}"
OUTPUT_TEMP=""
KEYS_COMMITTED="true"
trap 'exit 130' INT
trap 'exit 143' TERM

cat <<EOF

GAR setup complete. Credentials were written to:
  ${OUTPUT_PATH}

Securely copy these values into the Techulus deployment configuration, then
delete this file. The cleanup policy is not destructive until an operator
reviews the dry-run results and explicitly enables it with --no-dry-run.
EOF
