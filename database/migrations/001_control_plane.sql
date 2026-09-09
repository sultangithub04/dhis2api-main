BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE dhis2_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(120) NOT NULL,
  role varchar(20) NOT NULL CHECK (role IN ('source', 'destination', 'bidirectional')),
  base_url text NOT NULL,
  auth_type varchar(20) NOT NULL CHECK (auth_type IN ('pat', 'basic')),
  encrypted_secret bytea NOT NULL,
  secret_iv bytea NOT NULL,
  secret_tag bytea NOT NULL,
  dhis2_version varchar(40),
  system_name text,
  current_user_summary jsonb,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_test_status varchar(20) NOT NULL DEFAULT 'untested'
    CHECK (last_test_status IN ('untested', 'healthy', 'failed')),
  last_test_message text,
  last_tested_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dhis2_connections_name_unique UNIQUE (name)
);

CREATE INDEX dhis2_connections_role_active_idx
  ON dhis2_connections (role, is_active);

CREATE TABLE metadata_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES dhis2_connections(id) ON DELETE CASCADE,
  resource_type varchar(40) NOT NULL CHECK (resource_type IN ('program', 'dataset')),
  resource_uid varchar(20) NOT NULL,
  resource_name text NOT NULL,
  dhis2_version varchar(40),
  etag text,
  metadata jsonb NOT NULL,
  metadata_hash varchar(64) NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT metadata_snapshot_identity UNIQUE (connection_id, resource_type, resource_uid, metadata_hash)
);

CREATE TABLE schema_blueprints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL REFERENCES metadata_snapshots(id) ON DELETE RESTRICT,
  schema_name varchar(63) NOT NULL DEFAULT 'dhis_data',
  table_name varchar(63) NOT NULL,
  strategy varchar(30) NOT NULL CHECK (strategy IN ('normalized', 'flattened_latest', 'flattened_first', 'flattened_aggregate')),
  status varchar(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'applied', 'retired')),
  version integer NOT NULL DEFAULT 1,
  generated_by varchar(20) NOT NULL DEFAULT 'rules' CHECK (generated_by IN ('rules', 'ai_assisted', 'manual')),
  review_notes text,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schema_blueprint_version UNIQUE (snapshot_id, table_name, version)
);

CREATE TABLE schema_columns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blueprint_id uuid NOT NULL REFERENCES schema_blueprints(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  column_name varchar(63) NOT NULL,
  sql_type varchar(80) NOT NULL,
  source_kind varchar(40) NOT NULL CHECK (source_kind IN ('system', 'attribute', 'data_element', 'category_option_combo', 'derived')),
  source_uid varchar(20),
  stage_uid varchar(20),
  repeat_policy varchar(30),
  nullable boolean NOT NULL DEFAULT true,
  is_filterable boolean NOT NULL DEFAULT false,
  label text NOT NULL,
  mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT schema_column_ordinal UNIQUE (blueprint_id, ordinal),
  CONSTRAINT schema_column_name UNIQUE (blueprint_id, column_name)
);

CREATE TABLE sync_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(160) NOT NULL,
  source_connection_id uuid NOT NULL REFERENCES dhis2_connections(id) ON DELETE RESTRICT,
  destination_connection_id uuid REFERENCES dhis2_connections(id) ON DELETE RESTRICT,
  blueprint_id uuid REFERENCES schema_blueprints(id) ON DELETE RESTRICT,
  resource_type varchar(40) NOT NULL CHECK (resource_type IN ('tracker', 'aggregate', 'metadata')),
  resource_uid varchar(20) NOT NULL,
  direction varchar(30) NOT NULL DEFAULT 'pull' CHECK (direction IN ('pull', 'push', 'bidirectional')),
  conflict_policy varchar(30) NOT NULL DEFAULT 'source_wins'
    CHECK (conflict_policy IN ('source_wins', 'destination_wins', 'newest_wins', 'manual')),
  batch_size integer NOT NULL DEFAULT 500 CHECK (batch_size BETWEEN 1 AND 50000),
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sync_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_definition_id uuid NOT NULL REFERENCES sync_definitions(id) ON DELETE CASCADE,
  cron_expression varchar(120) NOT NULL,
  timezone varchar(80) NOT NULL DEFAULT 'UTC',
  execution_limit integer CHECK (execution_limit IS NULL OR execution_limit > 0),
  execution_count integer NOT NULL DEFAULT 0 CHECK (execution_count >= 0),
  is_active boolean NOT NULL DEFAULT true,
  next_run_at timestamptz,
  last_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sync_schedules_due_idx
  ON sync_schedules (next_run_at)
  WHERE is_active;

CREATE TABLE sync_cursors (
  sync_definition_id uuid PRIMARY KEY REFERENCES sync_definitions(id) ON DELETE CASCADE,
  cursor_type varchar(30) NOT NULL CHECK (cursor_type IN ('last_updated', 'page', 'continuation_token', 'period')),
  cursor_value jsonb NOT NULL,
  watermark_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_definition_id uuid NOT NULL REFERENCES sync_definitions(id) ON DELETE CASCADE,
  schedule_id uuid REFERENCES sync_schedules(id) ON DELETE SET NULL,
  trigger_type varchar(20) NOT NULL CHECK (trigger_type IN ('manual', 'scheduled', 'retry')),
  status varchar(20) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'partially_succeeded', 'failed', 'cancelled')),
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  records_read integer NOT NULL DEFAULT 0,
  records_written integer NOT NULL DEFAULT 0,
  records_skipped integer NOT NULL DEFAULT 0,
  records_failed integer NOT NULL DEFAULT 0,
  error_summary text,
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE INDEX sync_runs_definition_queued_idx
  ON sync_runs (sync_definition_id, queued_at DESC);

CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor varchar(160) NOT NULL DEFAULT 'system',
  action varchar(100) NOT NULL,
  entity_type varchar(80) NOT NULL,
  entity_id text,
  before_state jsonb,
  after_state jsonb,
  request_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
