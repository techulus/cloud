# Techulus Cloud - Control Plane

Next.js-based control plane for Techulus Cloud container deployment platform.

## Development

```bash
pnpm install
cp .env.example .env
docker compose -f ../compose.dev.yml up -d
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) to access the control plane.
Open [http://localhost:8288](http://localhost:8288) to access the Inngest dev server.

## Stack

- **Framework**: Next.js with App Router
- **Database**: Postgres with Drizzle ORM
- **Styling**: Tailwind CSS & Shadcn
