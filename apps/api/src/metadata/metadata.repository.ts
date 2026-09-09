import { Inject, Injectable } from "@nestjs/common";
import type { MetadataSnapshotSummary, ResourceType } from "@dhis-sync/contracts";
import { DatabaseService } from "../database/database.service.js";

interface SnapshotRow {
  id: string;
  connection_id: string;
  resource_type: ResourceType;
  resource_uid: string;
  resource_name: string;
  dhis2_version: string | null;
  metadata_hash: string;
  captured_at: Date;
  metadata: Record<string, unknown>;
}

export interface StoredMetadataSnapshot extends MetadataSnapshotSummary {
  metadata: Record<string, unknown>;
}

function mapSnapshot(row: SnapshotRow): StoredMetadataSnapshot {
  return {
    id: row.id,
    connectionId: row.connection_id,
    resourceType: row.resource_type,
    resourceUid: row.resource_uid,
    resourceName: row.resource_name,
    dhis2Version: row.dhis2_version,
    metadataHash: row.metadata_hash,
    capturedAt: row.captured_at.toISOString(),
    metadata: row.metadata
  };
}

@Injectable()
export class MetadataRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async save(input: {
    connectionId: string;
    resourceType: ResourceType;
    resourceUid: string;
    resourceName: string;
    dhis2Version: string | null;
    metadataHash: string;
    metadata: Record<string, unknown>;
  }): Promise<StoredMetadataSnapshot> {
    const result = await this.database.query<SnapshotRow>(
      `INSERT INTO metadata_snapshots (
        connection_id, resource_type, resource_uid, resource_name,
        dhis2_version, metadata, metadata_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (connection_id, resource_type, resource_uid, metadata_hash)
      DO UPDATE SET resource_name = EXCLUDED.resource_name
      RETURNING id, connection_id, resource_type, resource_uid, resource_name,
        dhis2_version, metadata_hash, captured_at, metadata`,
      [
        input.connectionId,
        input.resourceType,
        input.resourceUid,
        input.resourceName,
        input.dhis2Version,
        JSON.stringify(input.metadata),
        input.metadataHash
      ]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Metadata snapshot insert returned no row");
    return mapSnapshot(row);
  }

  async findById(id: string): Promise<StoredMetadataSnapshot | null> {
    const result = await this.database.query<SnapshotRow>(
      `SELECT id, connection_id, resource_type, resource_uid, resource_name,
        dhis2_version, metadata_hash, captured_at, metadata
      FROM metadata_snapshots WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? mapSnapshot(result.rows[0]) : null;
  }
}

