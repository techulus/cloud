# Self-Hosting Guide

## Prerequisites

- Node.js 22+
- PostgreSQL database
- Docker (for containerized deployment)

## Environment Variables

Create a `.env` file based on the `.env.example` file.

```bash
cp .env.example .env
```

## Running using Docker Compose

You can find the `docker-compose.yml` file in the root directory.

```bash
docker compose up -d
```
