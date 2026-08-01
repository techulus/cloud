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

For any requested code or configuration change, follow this order: research
and requirements confirmation, combined specification/development planning,
explicit approval of the completed plan, then implementation. Do not collapse
requirements refinement and specification/planning. In each phase, use its
named tool when available; otherwise follow that phase's fallback.

Research notes, requirements, specifications, and plans are workflow artifacts
and may be written or updated before approval. Do not change product code or
configuration until the user explicitly approves the completed specification
and development plan.

- Use subagents where helpful for bounded research, investigation, independent
  analysis, and synthesizing findings or answers.
- As each stage is completed, compact the working context into its agreed
  deliverable before progressing. Preserve material decisions, constraints,
  assumptions, unresolved questions, and risks.

### 1. Research and refine requirements

Understand the problem before designing a solution.

Use `research_codebase` when available: make its readiness call, send the
research question, and use same-session follow-ups for further investigation.
Synthesize its findings into requirements, constraints, assumptions,
non-goals, edge cases, and acceptance criteria; resolve material ambiguities
and present the refined requirements for confirmation.

If `research_codebase` is unavailable, inspect the relevant code and
constraints directly, summarize the same requirements, and obtain user
confirmation.

Deliverable: agreed requirements, constraints, assumptions, and acceptance
criteria.

### 2. Build the specification and development plan

Begin only after requirements are confirmed. Use `create_plan` when available:
start with the confirmed requirements and relevant research, then use
same-session follow-ups to resolve decisions and incorporate feedback. An
outline approval permits detailed-plan development only; implementation
requires explicit approval of the completed plan.

- Define user-visible and system behavior.
- Describe the technical approach, architecture, interfaces, data flow, and
  error handling.
- Address important edge cases and consequential tradeoffs.
- Keep the specification solution-level rather than file-by-file.
- List the files and modules that will be added, changed, renamed, or removed.
- Describe the specific changes required in each location.
- Include API, schema, type, dependency, and configuration changes where
  applicable.
- Define the tests and verification commands that will be run.
- Order the work into small, reviewable steps and identify remaining risks.

If `create_plan` is unavailable, define the behavior, architecture, edge cases,
file changes, and verification directly, resolve consequential decisions, and
present the complete plan for explicit approval.

Deliverable: a reviewable specification of the intended behavior and technical
design, plus an actionable, file-level development plan.

### 3. Implement after approval

After explicit approval, use `implement_plan` when available, starting with the
approved plan path. By default, complete one approved phase, run its automated
verification, update plan checkboxes, report the manual verification steps,
and pause for explicit confirmation before continuing.

If `implement_plan` is unavailable, follow the same phase-by-phase process and
stop on any material mismatch.

- Implement the approved plan using the smallest correct changes and existing
  project patterns.
- If a material mismatch affects requirements, specification, scope, or
  architecture, stop and return to the appropriate phase for approval.
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
