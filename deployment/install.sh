#!/usr/bin/env bash
set -euo pipefail

RAW_URL="https://raw.githubusercontent.com/techulus/cloud/main/deployment"
DEPLOY_DIR="/opt/techulus-cloud"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

ENV_FILE=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --env-file)
            ENV_FILE="$2"
            shift 2
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            exit 1
            ;;
    esac
done

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_header() { echo -e "\n${BOLD}${CYAN}=== $1 ===${NC}\n"; }

check_root() {
    if [[ $EUID -ne 0 ]]; then
        log_error "This script must be run as root (use sudo)"
        exit 1
    fi
}

detect_os() {
    if [[ ! -f /etc/os-release ]]; then
        log_error "Cannot detect OS: /etc/os-release not found"
        exit 1
    fi

    # shellcheck source=/dev/null
    . /etc/os-release

    case "$ID" in
        debian|ubuntu)
            OS_FAMILY="debian"
            ;;
        rhel|centos|rocky|almalinux|fedora)
            OS_FAMILY="rhel"
            ;;
        *)
            log_error "Unsupported OS: $ID"
            log_error "Supported: Debian, Ubuntu, RHEL, CentOS Stream, Rocky Linux, AlmaLinux, Fedora"
            exit 1
            ;;
    esac

    log_success "Detected OS: $PRETTY_NAME ($OS_FAMILY family)"
}

install_docker_debian() {
    log_info "Installing Docker via official apt repository..."

    apt-get update -qq
    apt-get install -y -qq ca-certificates curl gnupg >/dev/null

    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL "https://download.docker.com/linux/${ID}/gpg" | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg

    echo \
        "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${ID} \
        $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list

    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null
}

install_docker_rhel() {
    log_info "Installing Docker via official yum/dnf repository..."

    if command -v dnf &>/dev/null; then
        PKG_MGR="dnf"
    else
        PKG_MGR="yum"
    fi

    $PKG_MGR install -y -q yum-utils >/dev/null 2>&1 || true
    $PKG_MGR config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo 2>/dev/null || \
        yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo 2>/dev/null
    $PKG_MGR install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null
}

install_docker() {
    log_header "Docker Installation"

    if command -v docker &>/dev/null; then
        log_success "Docker is already installed: $(docker --version)"
    else
        log_info "Docker not found, installing..."

        case "$OS_FAMILY" in
            debian) install_docker_debian ;;
            rhel)   install_docker_rhel ;;
        esac

        log_success "Docker installed successfully"
    fi

    systemctl enable docker >/dev/null 2>&1
    systemctl start docker

    if docker compose version &>/dev/null; then
        log_success "Docker Compose plugin: $(docker compose version --short)"
    else
        log_error "Docker Compose plugin not available"
        exit 1
    fi
}

download_compose_files() {
    log_header "Downloading Compose Files"

    mkdir -p "$DEPLOY_DIR"

    curl -fsSL "${RAW_URL}/compose.production.yml" -o "${DEPLOY_DIR}/compose.production.yml"
    curl -fsSL "${RAW_URL}/compose.postgres.yml" -o "${DEPLOY_DIR}/compose.postgres.yml"

    log_success "Compose files downloaded to ${DEPLOY_DIR}"
}

prompt_value() {
    local var_name="$1"
    local prompt_text="$2"
    local default_value="${3:-}"
    local value

    if [[ -n "$default_value" ]]; then
        read -rp "$(echo -e "${CYAN}${prompt_text} [${default_value}]: ${NC}")" value
        value="${value:-$default_value}"
    else
        while [[ -z "${value:-}" ]]; do
            read -rp "$(echo -e "${CYAN}${prompt_text}: ${NC}")" value
            if [[ -z "$value" ]]; then
                log_warn "This value is required"
            fi
        done
    fi

    eval "$var_name='$value'"
}

configure_interactive() {
    log_header "Configuration"

    prompt_value ROOT_DOMAIN "Enter your root domain (e.g. cloud.example.com)"
    prompt_value ACME_EMAIL "Enter email for Let's Encrypt certificates"

    echo ""
    log_info "Database configuration"
    echo -e "  ${BOLD}1)${NC} Bundled PostgreSQL (recommended for single-server setups)"
    echo -e "  ${BOLD}2)${NC} External PostgreSQL (bring your own database)"
    echo ""

    local db_choice
    while true; do
        read -rp "$(echo -e "${CYAN}Choose database option [1]: ${NC}")" db_choice
        db_choice="${db_choice:-1}"
        case "$db_choice" in
            1)
                USE_BUNDLED_PG=true
                POSTGRES_USER="techulus"
                POSTGRES_PASSWORD="$(openssl rand -hex 16)"
                POSTGRES_DB="techulus"
                DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}"
                log_success "Bundled PostgreSQL selected"
                break
                ;;
            2)
                USE_BUNDLED_PG=false
                prompt_value DATABASE_URL "Enter PostgreSQL connection URL (postgres://user:pass@host:5432/db)"
                break
                ;;
            *)
                log_warn "Please enter 1 or 2"
                ;;
        esac
    done

    BETTER_AUTH_SECRET="$(openssl rand -hex 32)"
    ENCRYPTION_KEY="$(openssl rand -hex 32)"
    VL_USERNAME="admin"
    VL_PASSWORD="$(openssl rand -hex 16)"
    REGISTRY_USERNAME="admin"
    REGISTRY_PASSWORD="$(openssl rand -hex 16)"
    REGISTRY_HTTP_SECRET="$(openssl rand -hex 32)"
    INNGEST_SIGNING_KEY="signkey-prod-$(openssl rand -hex 32)"
    INNGEST_EVENT_KEY="$(openssl rand -hex 16)"

    if [[ "$USE_BUNDLED_PG" == "true" ]]; then
        COMPOSE_FILE="compose.postgres.yml"
    else
        COMPOSE_FILE="compose.production.yml"
    fi

    write_env_file
}

configure_from_file() {
    local src_file="$1"
    log_header "Configuration (from file)"

    if [[ ! -f "$src_file" ]]; then
        log_error "Env file not found: $src_file"
        exit 1
    fi

    cp "$src_file" "${DEPLOY_DIR}/.env"
    log_success "Configuration loaded from ${src_file}"

    if grep -q "^COMPOSE_FILE=" "${DEPLOY_DIR}/.env"; then
        COMPOSE_FILE="$(grep "^COMPOSE_FILE=" "${DEPLOY_DIR}/.env" | cut -d'=' -f2)"
    else
        COMPOSE_FILE="compose.production.yml"
    fi
}

write_env_file() {
    log_info "Writing configuration to ${DEPLOY_DIR}/.env"

    cat > "${DEPLOY_DIR}/.env" <<EOF
ROOT_DOMAIN=${ROOT_DOMAIN}
ACME_EMAIL=${ACME_EMAIL}

DATABASE_URL=${DATABASE_URL}

BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}
ENCRYPTION_KEY=${ENCRYPTION_KEY}

VL_USERNAME=${VL_USERNAME}
VL_PASSWORD=${VL_PASSWORD}
VL_RETENTION=7d

REGISTRY_USERNAME=${REGISTRY_USERNAME}
REGISTRY_PASSWORD=${REGISTRY_PASSWORD}
REGISTRY_HTTP_SECRET=${REGISTRY_HTTP_SECRET}

INNGEST_SIGNING_KEY=${INNGEST_SIGNING_KEY}
INNGEST_EVENT_KEY=${INNGEST_EVENT_KEY}

COMPOSE_FILE=${COMPOSE_FILE}
EOF

    if [[ "${USE_BUNDLED_PG:-false}" == "true" ]]; then
        cat >> "${DEPLOY_DIR}/.env" <<EOF

POSTGRES_USER=${POSTGRES_USER}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=${POSTGRES_DB}
EOF
    fi

    chmod 600 "${DEPLOY_DIR}/.env"
    log_success "Configuration written"
}

build_and_start() {
    log_header "Starting Services"

    cd "$DEPLOY_DIR"

    log_info "Pulling and starting services using ${COMPOSE_FILE}..."
    docker compose -f "$COMPOSE_FILE" up -d --pull always

    echo ""
    log_header "Deployment Complete"

    local root_domain
    root_domain="$(grep "^ROOT_DOMAIN=" "${DEPLOY_DIR}/.env" | cut -d'=' -f2)"

    echo -e "${GREEN}${BOLD}Services are starting up!${NC}"
    echo ""
    echo -e "  ${BOLD}Application:${NC}  https://${root_domain}"
    echo -e "  ${BOLD}Registry:${NC}     https://registry.${root_domain}"
    echo -e "  ${BOLD}Logs:${NC}         https://logs.${root_domain}"
    echo ""
    echo -e "  ${BOLD}Config file:${NC}  ${DEPLOY_DIR}/.env"
    echo -e "  ${BOLD}Compose file:${NC} ${DEPLOY_DIR}/${COMPOSE_FILE}"
    echo ""
    echo -e "${YELLOW}It may take a few minutes for SSL certificates to be provisioned.${NC}"
    echo ""

    docker compose -f "$COMPOSE_FILE" ps
}

main() {
    echo -e "${BOLD}${CYAN}"
    echo "  _____ _____ ____ _   _ _   _ _     _   _ ____   "
    echo " |_   _| ____/ ___| | | | | | | |   | | | / ___|  "
    echo "   | | |  _|| |   | |_| | | | | |   | | | \___ \  "
    echo "   | | | |__| |___|  _  | |_| | |___| |_| |___) | "
    echo "   |_| |_____\____|_| |_|\___/|_____|\\___/|____/  "
    echo ""
    echo -e "${NC}${BOLD}  Control Plane Installer${NC}"
    echo ""

    check_root
    detect_os
    install_docker
    download_compose_files

    if [[ -n "$ENV_FILE" ]]; then
        configure_from_file "$ENV_FILE"
    else
        configure_interactive
    fi

    build_and_start
}

main
