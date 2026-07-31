# Techulus Cloud — Agent Guide

An open container deployment platform. See README.md for architecture.

## Project facts

- **Unreleased beta.** Never build
  backward-compatibility shims, deprecation windows, or migration paths for
  old agent or API versions — delete and replace outright.
- The control plane and agent ship together; cross-cutting protocol changes
  land in one PR with no rollout ordering concerns.

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

## Spec-driven development workflow

For any requested code or configuration change, work through these phases in
order. Do not collapse requirements, specification, and implementation
planning into a single step.

### 1. Research and refine requirements

Understand the problem before designing a solution.

- Inspect the relevant code, documentation, existing behavior, and project
  constraints.
- Clarify the desired outcome, scope, non-goals, edge cases, and acceptance
  criteria.
- Identify assumptions and ask focused questions when ambiguity would
  materially affect the solution.
- Present the refined requirements for confirmation.

Deliverable: agreed requirements, constraints, assumptions, and acceptance
criteria.

### 2. Build the specification

Describe what will be built and how it should work.

- Define user-visible and system behavior.
- Describe the technical approach, architecture, interfaces, data flow, and
  error handling.
- Address important edge cases and consequential tradeoffs.
- Keep the specification solution-level rather than file-by-file.

Deliverable: a reviewable specification of the intended behavior and technical
design.

### 3. Create the development plan

Translate the specification into concrete implementation work.

- List the files and modules that will be added, changed, renamed, or removed.
- Describe the specific changes required in each location.
- Include API, schema, type, dependency, and configuration changes where
  applicable.
- Define the tests and verification commands that will be run.
- Order the work into small, reviewable steps and identify remaining risks.

Deliverable: an actionable, file-level development plan.

### 4. Implement after approval

Do not modify the codebase until the user approves the development plan.

- Implement the approved plan using the smallest correct changes and existing
  project patterns.
- Run the planned verification and report the results honestly.
- If new information requires a material change to the requirements,
  specification, scope, or architecture, pause implementation and return to
  the appropriate phase for approval.
- Resolve minor implementation details autonomously when they do not alter the
  approved behavior or scope.

Deliverable: implemented changes, verification results, and a concise summary
of any deviations or limitations.

## Communication

- Keep all written content as short as possible without omitting necessary
  detail. Expand only when explicitly asked.

## ⚠️ Critical restrictions

- **NEVER EVER merge a pull request.** This prohibition is absolute, even if
  the pull request is approved, checks pass, or the user asks you to ship it.
- **NEVER run the Node application** (`next dev`, `next start`, `pnpm dev`), Go Agent or Go CLI
  without explicit permission. Tests, typechecks, and `go build` are fine.
