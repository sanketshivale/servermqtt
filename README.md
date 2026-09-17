# Inverter telemetry service

A TypeScript MQTT ingestion service that stores inverter measurements in Supabase. It runs as one process/container; Supabase remains the external database.

## Structure

```text
src/
  config/env.ts           validated environment configuration
  telemetry/payload.ts    message contract and validation
  telemetry/ingestion.ts  bounded writes and shutdown drain
  storage/supabase.ts     database client and persistence
  mqtt/broker.ts          authentication and publish authorization
  observability/logger.ts structured JSON logs
  app.ts                  TCP/TLS, health endpoints and lifecycle
  index.ts                executable entry point and signals
scripts/dev.mjs           compiler and server development watchers
tests/                    unit and real MQTT integration tests
deploy/                   VPS deployment guide and optional SQL bootstrap
Dockerfile                multi-stage Node 22 image
compose.yml               private MQTT deployment
compose.tls.yml           public TLS deployment overlay
```

## Local development

Use Node 22 or newer (Node 22 is used in Docker).

```bash
npm ci
cp .env.example .env
# Edit .env with your Supabase URL/key and strong MQTT credentials.
# For local development set NODE_ENV=development, MQTT_HOST=127.0.0.1,
# and HEALTH_HOST=127.0.0.1.
npm run dev
```

```bash
npm run check
npm run build
npm start
```

`check` runs strict TypeScript checking and tests. Integration tests bind temporary loopback ports and use fake storage; they never access your real Supabase database. Existing `.env` credentials are not changed by this refactor. Add the new required MQTT credentials before starting.

## Device contract

Devices must authenticate with `MQTT_USERNAME` and `MQTT_PASSWORD`, publish to `MQTT_TOPIC` (default `inverter/telemetry`), use **QoS 1**, and disable retain. QoS 0/2, subscriptions, other topics, and telemetry wills are refused. This is an ingestion endpoint, not a general message broker.

```json
{
  "device_id": "inverter-001",
  "values": { "voltage": 230, "current": 4.2, "power": 966 },
  "timestamp": "2026-09-17T12:00:00Z"
}
```

`device_id` is trimmed and limited to 128 characters, `values` must be an object, and the optional timestamp must include time and timezone. When omitted, the database must supply its timestamp default. Payload size defaults to 64 KiB.

A QoS 1 PUBACK is sent only after both database requests succeed. Invalid messages, overload, or database failure disconnect the publisher without a successful acknowledgement. Devices must retain pending messages and reconnect/retry with backoff. Invalid messages should be corrected rather than retried forever.

QoS 1 provides at-least-once delivery: a disconnect after an insert but before PUBACK can produce duplicate rows on retry. The current schema has no message identifier for deduplication. The parent upsert and measurement insert are separate requests, so a failed insert can leave a parent row. No automatic database retries are performed because ambiguous insert outcomes could duplicate telemetry. For exactly-once business storage, introduce a device-generated event ID with a unique constraint and a transactional database function.

Credentials are shared across the trusted device fleet. They do not bind a device ID to a client. For untrusted tenants, add per-device credentials and device ID authorization before accepting those devices.

## Configuration

| Variable | Default / requirement |
| --- | --- |
| `SUPABASE_URL` | Required HTTPS project URL |
| `SUPABASE_SECRET_KEY` | Required server-only key; never ship to devices |
| `MQTT_USERNAME` | Required |
| `MQTT_PASSWORD` | Required, at least 16 characters |
| `MQTT_HOST`, `MQTT_PORT` | `127.0.0.1`, `1883` |
| `MQTT_TOPIC` | `inverter/telemetry`, no wildcards |
| `MQTT_TLS_CERT`, `MQTT_TLS_KEY` | Both required together to enable TLS |
| `ALLOW_INSECURE_MQTT` | Production without TLS requires explicit `true`; use only private transport |
| `HEALTH_HOST`, `HEALTH_PORT` | `127.0.0.1`, `8080` |
| `MAX_PAYLOAD_BYTES` | `65536`, maximum 1 MiB |
| `MAX_CONCURRENT_WRITES` | `8`, maximum 128 |
| `DB_TIMEOUT_MS` | `10000` per database request |
| `SHUTDOWN_TIMEOUT_MS` | `25000` |

Concurrency bounds database work without accumulating an application queue. There is no durable local spool or persistent MQTT session store: the device owns retransmission during outages. Tune concurrency using actual device traffic and Supabase capacity. Payload validation occurs after MQTT packet decoding; firewall restrictions and the container memory limit remain relevant for large malformed packets.

## Health and operations

`GET /healthz` checks process liveness; `GET /readyz` checks listener readiness and returns active writes and success/failure counts. Readiness does not probe Supabase availability; alert on failed writes and device delivery delay. Health ports are published only on loopback by Compose.

SIGTERM/SIGINT stops intake, drains accepted writes, disconnects clients and closes listeners. A timeout forces a nonzero exit. Compose restarts exited processes and rotates logs; an unhealthy Docker status alone does not restart a container. Add external monitoring for unattended operation.

See [Hostinger VPS deployment](deploy/HOSTINGER.md) for private access, public TLS, database preparation and updates.
# servermqtt
