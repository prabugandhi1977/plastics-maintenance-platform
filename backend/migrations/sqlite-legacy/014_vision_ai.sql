-- Vision AI: camera-based PPE compliance, fire and smoke, restricted-area intrusion and quality inspection.
-- Edge nodes (GPU PCs on the factory network) run the models, act locally (beacons, PLC, sirens, subnet broadcast)
-- and report here. This platform licenses modules per company, routes modules to cameras, holds the geofences,
-- records incidents with their evidence, and alerts people.

-- Vision duties decide which alarms a person is shown and their default dashboard: ehs, security, qa.
ALTER TABLE users ADD COLUMN vision_duties TEXT NOT NULL DEFAULT '[]';

-- Module licences: how many cameras may run each module, and until when.
CREATE TABLE IF NOT EXISTS vision_licences (company_id TEXT NOT NULL REFERENCES companies(id), module TEXT NOT NULL CHECK(module IN ('ppe','fire_smoke','quality','intrusion')),
  cameras INTEGER NOT NULL CHECK(cameras>=0), valid_until TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (company_id,module));

-- Edge nodes authenticate with their own key (only a hash is stored). config_version rises whenever anything the node
-- runs changes, so the node knows to fetch its configuration again.
CREATE TABLE IF NOT EXISTS vision_nodes (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), plant_id TEXT NOT NULL REFERENCES plants(id), name TEXT NOT NULL,
  hardware TEXT NOT NULL DEFAULT '', max_streams INTEGER NOT NULL DEFAULT 16, key_hash TEXT NOT NULL UNIQUE, key_hint TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT, agent_version TEXT, metrics TEXT NOT NULL DEFAULT '{}', config_version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);

-- Cameras. source_type follows the VisionForge camera gateway (rtsp, http-snapshot, cognex-native, folder) plus csi
-- (a camera on the node's own CSI/MIPI port) and visionforge (a VisionForge inspection station reporting results).
CREATE TABLE IF NOT EXISTS vision_cameras (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), plant_id TEXT NOT NULL REFERENCES plants(id), node_id TEXT REFERENCES vision_nodes(id),
  name TEXT NOT NULL, source_type TEXT NOT NULL CHECK(source_type IN ('rtsp','http-snapshot','cognex-native','folder','csi','visionforge')), source_url TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '', zone_id TEXT REFERENCES zones(id), equipment_id TEXT REFERENCES equipment(id), fps INTEGER NOT NULL DEFAULT 25,
  snapshot_media_id TEXT, status TEXT NOT NULL DEFAULT 'unknown', last_seen_at TEXT, metrics TEXT NOT NULL DEFAULT '{}', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);

-- Which modules run on which camera, with their settings (required PPE, quality preset, PLC and relay outputs...).
CREATE TABLE IF NOT EXISTS vision_assignments (camera_id TEXT NOT NULL REFERENCES vision_cameras(id), module TEXT NOT NULL CHECK(module IN ('ppe','fire_smoke','quality','intrusion')),
  enabled INTEGER NOT NULL DEFAULT 1, config TEXT NOT NULL DEFAULT '{}', updated_by TEXT REFERENCES users(id), updated_at TEXT NOT NULL, PRIMARY KEY (camera_id,module));

-- Shapes drawn over a camera's view, in image coordinates normalised to 0..1.
CREATE TABLE IF NOT EXISTS vision_zones (id TEXT PRIMARY KEY, camera_id TEXT NOT NULL REFERENCES vision_cameras(id), name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('exclusion','tripwire','allowed_motion','ppe_zone','inspection_roi')), points TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'critical' CHECK(severity IN ('warning','critical')),
  classes TEXT NOT NULL DEFAULT '["person","vehicle"]', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

-- Snapshots and clips. Files live next to the other uploads; locked media is never pruned.
CREATE TABLE IF NOT EXISTS vision_media (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), kind TEXT NOT NULL CHECK(kind IN ('snapshot','clip','frame')),
  mime TEXT NOT NULL, size_bytes INTEGER NOT NULL, storage_name TEXT NOT NULL, created_at TEXT NOT NULL);

-- Incidents and detections reported by the edge. (node_id, external_id) makes a replayed upload harmless.
CREATE TABLE IF NOT EXISTS vision_events (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), plant_id TEXT NOT NULL REFERENCES plants(id),
  camera_id TEXT NOT NULL REFERENCES vision_cameras(id), node_id TEXT REFERENCES vision_nodes(id), module TEXT NOT NULL, type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('info','warning','critical')), confidence REAL, occurred_at TEXT NOT NULL, received_at TEXT NOT NULL, latency_ms INTEGER,
  zone_id TEXT REFERENCES vision_zones(id), detail TEXT NOT NULL DEFAULT '{}', boxes TEXT NOT NULL DEFAULT '[]', edge_actions TEXT NOT NULL DEFAULT '{}',
  snapshot_media_id TEXT REFERENCES vision_media(id), clip_media_id TEXT REFERENCES vision_media(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','acknowledged','resolved','false_alarm')), acknowledged_by TEXT REFERENCES users(id), acknowledged_at TEXT,
  resolved_by TEXT REFERENCES users(id), resolved_at TEXT, resolution_note TEXT NOT NULL DEFAULT '', locked INTEGER NOT NULL DEFAULT 0, retrain INTEGER NOT NULL DEFAULT 0,
  external_id TEXT, alert_id TEXT, safety_event_id TEXT, UNIQUE(node_id,external_id));
CREATE INDEX IF NOT EXISTS idx_vision_events_company ON vision_events(company_id,occurred_at);
CREATE INDEX IF NOT EXISTS idx_vision_events_camera ON vision_events(camera_id,occurred_at);
CREATE INDEX IF NOT EXISTS idx_vision_events_open ON vision_events(status,severity);

-- Per-camera, per-minute counters from the edge: frames analysed, people seen and compliant, parts inspected and
-- passed, movements ignored because they were approved machine motion.
CREATE TABLE IF NOT EXISTS vision_stats (camera_id TEXT NOT NULL REFERENCES vision_cameras(id), minute TEXT NOT NULL, module TEXT NOT NULL,
  frames INTEGER NOT NULL DEFAULT 0, people INTEGER NOT NULL DEFAULT 0, compliant INTEGER NOT NULL DEFAULT 0, inspected INTEGER NOT NULL DEFAULT 0, passed INTEGER NOT NULL DEFAULT 0,
  ignored INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (camera_id,minute,module));

INSERT OR IGNORE INTO settings (key,value,updated_at) VALUES ('vision_settings','{"mediaRetentionDays":30,"qualityAlertRatePct":2,"clipSeconds":10,"preEventSeconds":5,"diskPrunePct":90,"broadcastGroup":"239.10.10.10","broadcastPort":5005}',datetime('now'));
