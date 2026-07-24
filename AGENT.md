# Techulus Cloud — Agent Guide

An open container deployment platform. See README.md for architecture.

## Project facts

- **Unreleased beta.** Prefer direct replacement for internal APIs, but keep a
  compatibility window for protocols used by independently upgraded agents.
- For agent protocol changes, deploy backward-compatible control-plane support
  first, upgrade the agent fleet, then remove the old protocol after the
  supported agent-version floor advances.

## Repo map

- `web/` — Next.js control plane (PostgreSQL + Drizzle, Inngest workflows)
- `agent/` — Go server agent (Podman, Traefik, WireGuard)
- `cli/` — Go CLI
- `deployment/` — production Compose files and updater
- `proxy/`, `registry/`, `logging/` — supporting service configs
- `docs/` — documentation

## Commands

- Web tests: `cd web && pnpm test`
- Web typecheck: `cd web && ./node_modules/.bin/tsc --noEmit`
- Web lint/format: `cd web && npx biome check --write <files>`
- Go (agent/cli): `go build ./...`, `go test ./...`, `gofmt -l .`
- After deleting or renaming a Next.js route, stale generated types in
  `web/.next/types` can fail the typecheck — delete them; they regenerate.

## Making changes

- Pull latest main before starting; if there are conflicts, STOP.
- If product or architectural intent is unclear, ask — don't guess.
- Create a branch before committing; never commit to main or a release branch.
- Tests are expensive to write and maintain. Only add or expand tests for
  high-value critical behavior, serious regression risk, or contracts that
  would be costly to break. Keep tests focused; avoid low-signal harnesses.

## ⚠️ Critical restrictions

- **NEVER run the Node application** (`next dev`, `next start`, `pnpm dev`), Go Agent or Go CLI
  without explicit permission. Tests, typechecks, and `go build` are fine.
