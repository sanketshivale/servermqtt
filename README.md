# Inverter MQTT Server

A TypeScript MQTT broker built with Aedes that receives inverter telemetry and stores it in Supabase. Each accepted message registers its device in `data_logger` and inserts a reading into `data_telemetry`.

## Requirements

- Node.js 22 (see `.nvmrc`) and npm
- A Supabase project with the tables described below
- Docker and Docker Compose, if running in a container

## Configuration

Copy the environment template and fill in your Supabase credentials:

```bash
cp .env.example .env
```

| Variable | Description | Default |
| --- | --- | --- |
| `SUPABASE_URL` | Supabase project URL (required) | — |
| `SUPABASE_SECRET_KEY` | Server-only Supabase key with permission to write to both tables (required) | — |
| `MQTT_PORT` | TCP port for the MQTT broker | `1883` |
| `MQTT_TOPIC` | Exact topic whose messages are saved | `inverter/telemetry` |

Keep the Supabase secret key private. The server loads `.env` through `dotenv`.

## Supabase tables

Create these tables in the schema exposed by your Supabase API before sending telemetry:

| Table | Required columns and constraints |
| --- | --- |
| `data_logger` | `device_id` text with a unique constraint or primary key, used for upserts |
| `data_telemetry` | `device_id` text, `values` JSONB, and `timestamp` timestamp with time zone |

If readings without a timestamp should receive an ingestion time, give `data_telemetry.timestamp` a database default such as `now()`. Any additional required columns must have defaults because the server only writes the fields listed above. Ensure the configured key can upsert devices and insert telemetry.

## Run locally

```bash
npm ci
npm run build
node dist/server.js
```

The broker listens on the configured TCP port. Run these commands from the project root so `.env` is loaded.

The current `npm start` and `npm run dev` scripts reference `dist/index.js` and `src/index.ts`, respectively, but the application entry point is `src/server.ts`. Use the command above to run the server.

## Run with Docker

After configuring `.env`:

```bash
docker compose up --build -d
docker compose logs -f mqtt-server
```

Stop the service with:

```bash
docker compose down
```

Compose publishes port `1883` and restarts the service unless it is stopped. If you change `MQTT_PORT`, update the Compose port mapping to match the container's listening port.

## Send telemetry

Publish a JSON message to `inverter/telemetry` (or your configured topic):

```json
{
  "device_id": "inverter-001",
  "values": {
    "voltage": 230,
    "current": 4.2,
    "power": 966
  },
  "timestamp": "2026-09-17T12:00:00Z"
}
```

- `device_id` must be a non-empty string; surrounding whitespace is removed.
- `values` must be a JSON object. Measurement names and values are unrestricted.
- `timestamp` is optional. Use an ISO 8601 date string when providing it.

For example, with the Mosquitto command-line client installed:

```bash
mosquitto_pub -h localhost -p 1883 -t inverter/telemetry \
  -m '{"device_id":"inverter-001","values":{"voltage":230,"power":966}}'
```

Messages on other topics and empty payloads are ignored. Invalid payloads and database errors are logged. Device registration and telemetry insertion are separate database operations; MQTT delivery acknowledgement does not confirm that a reading was stored, and the application has no database retry queue.

The broker currently uses plain MQTT over TCP without client authentication or TLS. Restrict access to trusted clients when deploying it.

## Development

```bash
npm test        # TypeScript type checking; no runtime test suite
npm run build  # Compile src/ into dist/
```

`src/server.ts` contains payload validation, Supabase writes, broker setup, and signal handling for shutdown. The Dockerfile builds the TypeScript source and runs `dist/server.js` with production dependencies.
