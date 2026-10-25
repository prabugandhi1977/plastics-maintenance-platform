-- Machine connectors: Monitor polls a machine directly (OPC UA / Euromap 77, Euromap 63 files, Modbus TCP) and
-- feeds what it reads into the same intake as POST /api/ingest. One row per connector; a machine may have several.
CREATE TABLE connectors (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('opcua','euromap63','modbus')),
  -- opc.tcp://host:4840 for OPC UA, host:port for Modbus TCP, the session folder for Euromap 63.
  endpoint TEXT NOT NULL,
  poll_ms INTEGER NOT NULL CHECK(poll_ms >= 1000),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  -- Type settings (security mode, read mode, Modbus unit ID, timeouts) and the machine-state source with its mapping.
  options TEXT NOT NULL DEFAULT '{}',
  -- Signal key → where its value comes from: an OPC UA node, a Euromap 63 parameter or a Modbus register.
  mapping TEXT NOT NULL DEFAULT '{}',
  -- OPC UA user name. The password is never stored in clear: either encrypted here (AES-256-GCM, key derived from
  -- MONITOR_SECRET) or the name of an environment variable (MONITOR_CONNECTOR_*) that holds it.
  username TEXT NOT NULL DEFAULT '',
  password_enc TEXT,
  password_env TEXT,
  -- Bumped on every change, so the supervisor restarts a running connector with its new settings.
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL);
CREATE INDEX connectors_by_machine ON connectors(machine_id);
