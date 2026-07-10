FROM golang:1.25-alpine AS builder
WORKDIR /src
COPY go.mod main.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/control-plane-updater .

FROM docker:28-cli@sha256:625d9431a9f54c5a2bc90f24f0e1c3d55b1349fd857dd85035f98c2c9acbdd4d AS docker-cli

FROM alpine:3.23

# Keep pg_dump on the same major version as the bundled postgres:18 service.
RUN apk add --no-cache ca-certificates curl postgresql18-client

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose

RUN pg_dump --version | grep -Eq 'PostgreSQL\) 18\.' \
    && docker --version \
    && docker compose version \
    && curl --version

WORKDIR /app
COPY --from=builder /out/control-plane-updater ./control-plane-updater

ENV PORT=8080
EXPOSE 8080

CMD ["/app/control-plane-updater"]
