#!/bin/sh
set -e

if [ -n "$REGISTRY_USERNAME" ] && [ -n "$REGISTRY_PASSWORD" ]; then
    htpasswd -Bbn "$REGISTRY_USERNAME" "$REGISTRY_PASSWORD" > /etc/docker/registry/htpasswd
fi

exec registry serve /etc/docker/registry/config.yml
