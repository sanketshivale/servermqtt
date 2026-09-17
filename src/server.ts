import 'dotenv/config';
import { createServer } from 'node:net';
import { Aedes } from 'aedes';
import type { Client } from 'aedes';
import type { AedesPublishPacket } from 'aedes';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { WebSocketLikeConstructor } from '@supabase/realtime-js';
import WebSocket from 'ws';

type TelemetryPayload = {
  device_id: string;
  values: Record<string, unknown>;
  timestamp?: string;
};

const port = Number(process.env.MQTT_PORT ?? 1883);
const topic = process.env.MQTT_TOPIC ?? 'inverter/telemetry';
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are required');
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('MQTT_PORT must be a valid TCP port');
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  realtime: { transport: WebSocket as unknown as WebSocketLikeConstructor },
});

const broker = await Aedes.createBroker();

function parseTelemetry(payload: Buffer): TelemetryPayload {
  let parsed: unknown;

  try {
    parsed = JSON.parse(payload.toString('utf8'));
  } catch {
    throw new Error('payload must be valid JSON');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('payload must be a JSON object');
  }

  const value = parsed as Record<string, unknown>;
  if (typeof value.device_id !== 'string' || value.device_id.trim() === '') {
    throw new Error('device_id must be a non-empty string');
  }

  if (!value.values || typeof value.values !== 'object' || Array.isArray(value.values)) {
    throw new Error('values must be a JSON object');
  }

  if (value.timestamp !== undefined && typeof value.timestamp !== 'string') {
    throw new Error('timestamp must be an ISO date string');
  }

  if (value.timestamp && Number.isNaN(Date.parse(value.timestamp))) {
    throw new Error('timestamp must be a valid ISO date string');
  }

  return {
    device_id: value.device_id.trim(),
    values: value.values as Record<string, unknown>,
    ...(value.timestamp ? { timestamp: value.timestamp } : {}),
  };
}

async function saveTelemetry(client: SupabaseClient, telemetry: TelemetryPayload): Promise<void> {
  const { error: loggerError } = await client
    .from('data_logger')
    .upsert({ device_id: telemetry.device_id }, { onConflict: 'device_id' });

  if (loggerError) {
    throw new Error(`data_logger upsert failed: ${loggerError.message}`);
  }

  const row = {
    device_id: telemetry.device_id,
    values: telemetry.values,
    ...(telemetry.timestamp ? { timestamp: telemetry.timestamp } : {}),
  };

  const { error: telemetryError } = await client.from('data_telemetry').insert(row);
  if (telemetryError) {
    throw new Error(`data_telemetry insert failed: ${telemetryError.message}`);
  }
}

broker.on('publish', async (packet: AedesPublishPacket, _client: Client | null) => {
  if (packet.topic !== topic || packet.payload.length === 0) {
    return;
  }

  try {
    const telemetry = parseTelemetry(Buffer.from(packet.payload));
    await saveTelemetry(supabase, telemetry);
    console.log(`saved telemetry for ${telemetry.device_id}`);
  } catch (error) {
    console.error(`failed to save MQTT message on ${packet.topic}:`, error);
  }
});

broker.on('clientError', (client: Client, error: Error) => {
  console.error(`MQTT client error${client ? ` (${client.id})` : ''}:`, error);
});

const server = createServer(broker.handle);
server.listen(port, () => {
  console.log(`MQTT server listening on mqtt://localhost:${port}`);
  console.log(`Telemetry topic: ${topic}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`received ${signal}, shutting down`);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  broker.close(() => process.exit(0));
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

export { parseTelemetry, saveTelemetry };