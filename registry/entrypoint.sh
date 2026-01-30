#!/bin/sh
set -e

if [ -n "$REGISTRY_USER" ] && [ -n "$REGISTRY_PASSWORD" ]; then
    htpasswd -Bbn "$REGISTRY_USER" "$REGISTRY_PASSWORD" > /etc/docker/registry/htpasswd
fi

exec registry serve /etc/docker/registry/config.yml
