#!/bin/sh
set -e

if [ -n "$REGISTRY_USERNAME" ] && [ -n "$REGISTRY_PASSWORD" ]; then
    htpasswd -Bbn "$REGISTRY_USERNAME" "$REGISTRY_PASSWORD" > /etc/distribution/htpasswd
fi

exec /bin/registry serve /etc/distribution/config.yml
