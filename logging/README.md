# Logging

VictoriaLogs for centralized log storage. Agents push container and build logs here.

## Usage

```bash
docker compose up -d
```

## Configuration

- **Port**: 9428
- **Retention**: 7 days
- **Data**: Persisted in `victoria-logs-data` volume

## Endpoints

- `POST /insert/jsonline` - Ingest logs (JSON Lines format)
- `GET /select/logsql/query` - Query logs via LogsQL
