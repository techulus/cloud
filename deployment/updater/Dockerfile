FROM golang:1.25-alpine AS builder
WORKDIR /src
COPY go.mod main.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/control-plane-updater .

FROM docker:28-cli

RUN apk add --no-cache bash curl docker-cli-compose postgresql-client

WORKDIR /app
COPY --from=builder /out/control-plane-updater ./control-plane-updater

ENV PORT=8080
EXPOSE 8080

CMD ["/app/control-plane-updater"]
