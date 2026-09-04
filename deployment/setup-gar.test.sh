#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETUP_SCRIPT="${SCRIPT_DIR}/setup-gar.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/setup-gar-test.XXXXXX")"

cleanup() {
    rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

assert_contains() {
    local expected="$1"
    local path="$2"

    grep -F -- "$expected" "$path" >/dev/null ||
        fail "expected '${expected}' in ${path}"
}

assert_not_contains() {
    local unexpected="$1"
    local path="$2"

    if grep -F -- "$unexpected" "$path" >/dev/null; then
        fail "did not expect '${unexpected}' in ${path}"
    fi
}

make_fake_gcloud() {
    local bin_dir="$1"

    mkdir -p "$bin_dir"
    cat > "${bin_dir}/gcloud" <<'EOF'
#!/usr/bin/env bash

set -eu

(
    printf '%s' "$1"
    shift
    for argument in "$@"; do
        printf '\t%s' "$argument"
    done
    printf '\n'
) >> "$FAKE_GCLOUD_LOG"

case "$*" in
    "auth list"*)
        echo "operator@example.com"
        ;;
    "projects describe "*)
        echo "test-project"
        ;;
    "services enable "*)
        ;;
    "artifacts repositories describe "*)
        if [[ "${FAKE_EXISTING:-0}" == "1" ]]; then
            echo '{"format":"DOCKER","mode":"STANDARD_REPOSITORY"}'
        else
            exit 1
        fi
        ;;
    "artifacts repositories create "*)
        ;;
    "iam service-accounts describe "*)
        [[ "${FAKE_EXISTING:-0}" == "1" ]]
        ;;
    "iam service-accounts create "*)
        ;;
    "artifacts repositories add-iam-policy-binding "*)
        ;;
    "artifacts repositories list-cleanup-policies "*)
        if [[ "${FAKE_CLEANUP_POLICIES:-0}" == "1" ]]; then
            echo "existing-policy"
        fi
        ;;
    "artifacts repositories set-cleanup-policies "*)
        ;;
    "iam service-accounts keys create "*)
        key_file="$5"
        service_account=""
        for argument in "$@"; do
            case "$argument" in
                --iam-account=*) service_account="${argument#*=}" ;;
            esac
        done

        if [[ "$service_account" == techulus-control-plane@* ]]; then
            if [[ "${FAKE_FAIL_ADMIN_KEY:-0}" == "1" ]]; then
                echo "simulated admin key failure" >&2
                exit 1
            fi
            key_name="admin"
        else
            key_name="agent"
        fi

        jq -n \
            --arg key_name "$key_name" \
            --arg service_account "$service_account" \
            '{
                type: ("service_" + "account"),
                project_id: "test-project",
                private_key_id: ($key_name + "-key-id"),
                private_key: ("-----BEGIN PRIVATE KEY-----\nFAKE_PRIVATE_" + $key_name + "\n-----END PRIVATE KEY-----\n"),
                client_email: $service_account,
                token_uri: "https://oauth2.googleapis.com/token"
            }' > "$key_file"
        ;;
    "iam service-accounts keys delete "*)
        ;;
    *)
        echo "unexpected gcloud invocation: $*" >&2
        exit 99
        ;;
esac
EOF
    chmod +x "${bin_dir}/gcloud"
}

run_setup() {
    local case_dir="$1"
    shift

    printf '%s\n' "test-project" | env \
        HOME="${case_dir}/home" \
        TMPDIR="${case_dir}/tmp" \
        PATH="${case_dir}/bin:${PATH}" \
        FAKE_GCLOUD_LOG="${case_dir}/gcloud.log" \
        "$@" \
        "$SETUP_SCRIPT" \
        --project test-project \
        --location us-central1 \
        --repository techulus-images \
        --output "${case_dir}/credentials.env" \
        > "${case_dir}/run.log" 2>&1
}

new_case() {
    local case_name="$1"
    local case_dir="${TEST_ROOT}/${case_name}"

    mkdir -p "${case_dir}/home" "${case_dir}/tmp"
    : > "${case_dir}/gcloud.log"
    make_fake_gcloud "${case_dir}/bin"
    echo "$case_dir"
}

test_fresh_provisioning() {
    local case_dir agent_key admin_key
    case_dir="$(new_case fresh)"

    run_setup "$case_dir"

    [[ -f "${case_dir}/credentials.env" ]] || fail "credential output was not created"
    [[ "$(stat -c '%a' "${case_dir}/credentials.env")" == "600" ]] ||
        fail "credential output is not mode 600"
    [[ "$(wc -l < "${case_dir}/credentials.env")" -eq 3 ]] ||
        fail "credential output does not have exactly three lines"

    assert_contains "GAR_REPOSITORY=us-central1-docker.pkg.dev/test-project/techulus-images" "${case_dir}/credentials.env"
    assert_contains $'services\tenable\tartifactregistry.googleapis.com\tiam.googleapis.com\t--project=test-project\t--quiet' "${case_dir}/gcloud.log"
    assert_contains $'artifacts\trepositories\tcreate\ttechulus-images' "${case_dir}/gcloud.log"
    assert_contains "--role=roles/artifactregistry.writer" "${case_dir}/gcloud.log"
    assert_contains "--role=roles/artifactregistry.repoAdmin" "${case_dir}/gcloud.log"
    assert_contains $'artifacts\trepositories\tset-cleanup-policies\ttechulus-images' "${case_dir}/gcloud.log"
    assert_contains "--dry-run" "${case_dir}/gcloud.log"
    assert_not_contains "--no-dry-run" "${case_dir}/gcloud.log"
    assert_not_contains "FAKE_PRIVATE" "${case_dir}/run.log"

    agent_key="$(sed -n 's/^GAR_AGENT_KEY_BASE64=//p' "${case_dir}/credentials.env")"
    admin_key="$(sed -n 's/^GAR_ADMIN_KEY_BASE64=//p' "${case_dir}/credentials.env")"
    printf '%s' "$agent_key" | base64 --decode | jq -e '
        .type == "service_account" and
        .private_key_id == "agent-key-id" and
        .client_email == "techulus-agent@test-project.iam.gserviceaccount.com"
    ' >/dev/null || fail "agent key output is invalid"
    printf '%s' "$admin_key" | base64 --decode | jq -e '
        .type == "service_account" and
        .private_key_id == "admin-key-id" and
        .client_email == "techulus-control-plane@test-project.iam.gserviceaccount.com"
    ' >/dev/null || fail "admin key output is invalid"

    [[ -z "$(find "${case_dir}/tmp" -mindepth 1 -print -quit)" ]] ||
        fail "temporary key files remain after success"
}

test_existing_resources_are_preserved() {
    local case_dir
    case_dir="$(new_case existing)"

    run_setup "$case_dir" FAKE_EXISTING=1 FAKE_CLEANUP_POLICIES=1

    assert_not_contains $'artifacts\trepositories\tcreate\t' "${case_dir}/gcloud.log"
    assert_not_contains $'iam\tservice-accounts\tcreate\t' "${case_dir}/gcloud.log"
    assert_not_contains $'artifacts\trepositories\tset-cleanup-policies\t' "${case_dir}/gcloud.log"
    assert_contains "Existing cleanup policies were preserved." "${case_dir}/run.log"
    [[ -f "${case_dir}/credentials.env" ]] || fail "rerun did not create fresh credentials"
}

test_existing_output_is_not_overwritten() {
    local case_dir
    case_dir="$(new_case overwrite)"
    echo "keep-me" > "${case_dir}/credentials.env"

    if run_setup "$case_dir"; then
        fail "setup unexpectedly overwrote an existing output"
    fi

    [[ "$(cat "${case_dir}/credentials.env")" == "keep-me" ]] ||
        fail "existing output changed"
    assert_not_contains $'services\tenable\t' "${case_dir}/gcloud.log"
    assert_not_contains $'keys\tcreate\t' "${case_dir}/gcloud.log"
}

test_partial_key_failure_revokes_created_key() {
    local case_dir
    case_dir="$(new_case rollback)"

    if run_setup "$case_dir" FAKE_FAIL_ADMIN_KEY=1; then
        fail "setup unexpectedly succeeded after key creation failure"
    fi

    [[ ! -e "${case_dir}/credentials.env" ]] || fail "failed setup wrote credentials"
    assert_contains $'iam\tservice-accounts\tkeys\tdelete\tagent-key-id' "${case_dir}/gcloud.log"
    assert_not_contains $'iam\tservice-accounts\tkeys\tdelete\tadmin-key-id' "${case_dir}/gcloud.log"
    assert_not_contains "FAKE_PRIVATE" "${case_dir}/run.log"
    [[ -z "$(find "${case_dir}/tmp" -mindepth 1 -print -quit)" ]] ||
        fail "temporary key files remain after failure"
}

test_fresh_provisioning
test_existing_resources_are_preserved
test_existing_output_is_not_overwritten
test_partial_key_failure_revokes_created_key

echo "setup-gar tests passed"
