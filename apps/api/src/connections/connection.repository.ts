import { Inject, Injectable } from "@nestjs/common";
import type {
  AuthType,
  ConnectionRole,
  ConnectionSummary,
  ConnectionTestResult,
  Dhis2Capabilities
} from "@dhis-sync/contracts";
import { DatabaseService } from "../database/database.service.js";
import type { EncryptedSecret } from "../security/secret-cipher.service.js";

interface ConnectionRow {
  id: string;
  name: string;
  role: ConnectionRole;
  base_url: string;
  auth_type: AuthType;
  encrypted_secret: Buffer;
  secret_iv: Buffer;
  secret_tag: Buffer;
  dhis2_version: string | null;
  system_name: string | null;
  capabilities: Dhis2Capabilities | Record<string, never>;
  last_test_status: "untested" | "healthy" | "failed";
  last_test_message: string | null;
  last_tested_at: Date | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface StoredConnection extends ConnectionSummary, EncryptedSecret {}

export interface InsertConnection {
  name: string;
  role: ConnectionRole;
  baseUrl: string;
  authType: AuthType;
  encryptedSecret: EncryptedSecret;
  test: ConnectionTestResult | null;
}

export interface UpdateConnection extends InsertConnection { id: string; isActive: boolean; }

const columns = `
  id, name, role, base_url, auth_type, encrypted_secret, secret_iv, secret_tag,
  dhis2_version, system_name, capabilities, last_test_status, last_test_message,
  last_tested_at, is_active, created_at, updated_at`;

function mapRow(row: ConnectionRow): StoredConnection {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    baseUrl: row.base_url,
    authType: row.auth_type,
    dhis2Version: row.dhis2_version,
    systemName: row.system_name,
    capabilities: row.capabilities,
    lastTestStatus: row.last_test_status,
    lastTestMessage: row.last_test_message,
    lastTestedAt: row.last_tested_at?.toISOString() ?? null,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ciphertext: row.encrypted_secret,
    iv: row.secret_iv,
    tag: row.secret_tag
  };
}

@Injectable()
export class ConnectionRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async list(): Promise<StoredConnection[]> {
    const result = await this.database.query<ConnectionRow>(
      `SELECT ${columns} FROM dhis2_connections ORDER BY created_at DESC`
    );
    return result.rows.map(mapRow);
  }

  async findById(id: string): Promise<StoredConnection | null> {
    const result = await this.database.query<ConnectionRow>(
      `SELECT ${columns} FROM dhis2_connections WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async findByName(name: string): Promise<StoredConnection | null> {
    const result = await this.database.query<ConnectionRow>(
      `SELECT ${columns} FROM dhis2_connections WHERE lower(name) = lower($1) LIMIT 1`,
      [name.trim()]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async insert(input: InsertConnection): Promise<StoredConnection> {
    const test = input.test;
    const result = await this.database.query<ConnectionRow>(
      `INSERT INTO dhis2_connections (
        name, role, base_url, auth_type, encrypted_secret, secret_iv, secret_tag,
        dhis2_version, system_name, current_user_summary, capabilities,
        last_test_status, last_test_message, last_tested_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING ${columns}`,
      [
        input.name,
        input.role,
        input.baseUrl,
        input.authType,
        input.encryptedSecret.ciphertext,
        input.encryptedSecret.iv,
        input.encryptedSecret.tag,
        test?.dhis2Version ?? null,
        test?.systemName ?? null,
        test?.currentUser ? JSON.stringify(test.currentUser) : null,
        JSON.stringify(test?.capabilities ?? {}),
        test ? "healthy" : "untested",
        test?.message ?? null,
        test?.testedAt ?? null
      ]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Connection insert returned no row");
    return mapRow(row);
  }

  async update(input: UpdateConnection): Promise<StoredConnection> {
    const test = input.test;
    const result = await this.database.query<ConnectionRow>(
      `UPDATE dhis2_connections SET name=$2, role=$3, base_url=$4, auth_type=$5,
       encrypted_secret=$6, secret_iv=$7, secret_tag=$8, is_active=$9,
       dhis2_version=$10, system_name=$11, current_user_summary=$12, capabilities=$13,
       last_test_status=$14, last_test_message=$15, last_tested_at=$16, updated_at=now()
       WHERE id=$1 RETURNING ${columns}`,
      [input.id, input.name, input.role, input.baseUrl, input.authType,
       input.encryptedSecret.ciphertext, input.encryptedSecret.iv, input.encryptedSecret.tag, input.isActive,
       test?.dhis2Version ?? null, test?.systemName ?? null,
       test?.currentUser ? JSON.stringify(test.currentUser) : null, JSON.stringify(test?.capabilities ?? {}),
       test ? "healthy" : "untested", test?.message ?? null, test?.testedAt ?? null]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Connection not found");
    return mapRow(row);
  }

  async recordTest(id: string, test: ConnectionTestResult): Promise<StoredConnection> {
    const result = await this.database.query<ConnectionRow>(
      `UPDATE dhis2_connections SET
        base_url = $2,
        dhis2_version = $3,
        system_name = $4,
        current_user_summary = $5,
        capabilities = $6,
        last_test_status = 'healthy',
        last_test_message = $7,
        last_tested_at = $8,
        updated_at = now()
      WHERE id = $1
      RETURNING ${columns}`,
      [
        id,
        test.normalizedBaseUrl,
        test.dhis2Version,
        test.systemName,
        test.currentUser ? JSON.stringify(test.currentUser) : null,
        JSON.stringify(test.capabilities),
        test.message,
        test.testedAt
      ]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Connection not found");
    return mapRow(row);
  }

  async recordFailure(id: string, message: string): Promise<void> {
    await this.database.query(
      `UPDATE dhis2_connections SET
        last_test_status = 'failed', last_test_message = $2,
        last_tested_at = now(), updated_at = now()
      WHERE id = $1`,
      [id, message]
    );
  }

  async dependencyCounts(id: string): Promise<{ blueprints: number; syncDefinitions: number }> {
    const result = await this.database.query<{ blueprints: string; sync_definitions: string }>(
      `SELECT
        (SELECT count(*) FROM schema_blueprints b
          JOIN metadata_snapshots s ON s.id=b.snapshot_id WHERE s.connection_id=$1)::text AS blueprints,
        (SELECT count(*) FROM sync_definitions WHERE source_connection_id=$1 OR destination_connection_id=$1)::text AS sync_definitions`,
      [id]
    );
    return {
      blueprints: Number(result.rows[0]?.blueprints ?? 0),
      syncDefinitions: Number(result.rows[0]?.sync_definitions ?? 0)
    };
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.database.query(`DELETE FROM dhis2_connections WHERE id=$1`, [id]);
    return Boolean(result.rowCount);
  }
}
