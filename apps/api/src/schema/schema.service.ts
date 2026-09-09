import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { GenerateBlueprintInput, SchemaBlueprintSummary, UpdateBlueprintInput } from "@dhis-sync/contracts";
import { MetadataService } from "../metadata/metadata.service.js";
import { generateColumns, tableNameFor } from "./schema-generator.js";
import { SchemaRepository } from "./schema.repository.js";

@Injectable()
export class SchemaService {
  constructor(
    @Inject(MetadataService) private readonly metadata: MetadataService,
    @Inject(SchemaRepository) private readonly repository: SchemaRepository
  ) {}

  list(): Promise<SchemaBlueprintSummary[]> {
    return this.repository.list();
  }

  async generate(input: GenerateBlueprintInput): Promise<SchemaBlueprintSummary> {
    const snapshot = await this.metadata.discover(input);
    const columns = generateColumns(input.resourceType, snapshot.metadata, input.strategy);
    if (columns.length <= 1) throw new BadRequestException("No schema fields were found in the DHIS2 metadata");
    return this.repository.create({
      snapshotId: snapshot.id,
      tableName: tableNameFor(snapshot.resourceName, snapshot.resourceUid),
      strategy: input.strategy,
      columns
    });
  }

  async apply(id: string): Promise<SchemaBlueprintSummary> {
    const existing = await this.repository.findById(id);
    if (!existing) throw new NotFoundException("Schema blueprint not found");
    if (existing.status === "retired") throw new BadRequestException("A retired blueprint cannot be applied");
    return this.repository.apply(id);
  }

  async update(id: string, input: UpdateBlueprintInput): Promise<SchemaBlueprintSummary> {
    const existing = await this.repository.findById(id);
    if (!existing) throw new NotFoundException("Schema blueprint not found");
    const existingNames = new Set(existing.columns.map((column) => column.columnName));
    if (input.columns.some((column) => !existingNames.has(column.columnName))) {
      throw new BadRequestException("The update contains a column that does not belong to this blueprint");
    }
    return this.repository.updateColumns(id, input.columns);
  }

  async dropTable(
    id: string,
    confirmation: string,
    cascadeDependencies = false
  ): Promise<{ dropped: true; deletedSyncDefinitions: number }> {
    const existing = await this.repository.findById(id);
    if (!existing) throw new NotFoundException("Schema blueprint not found");
    if (confirmation !== existing.tableName) {
      throw new BadRequestException(`Type the table name ${existing.tableName} to confirm deletion`);
    }
    const syncCount = await this.repository.syncDependencyCount(id);
    if (syncCount && !cascadeDependencies) {
      throw new ConflictException(
        `${syncCount} sync definition(s) use this table. Confirm cascading deletion to remove them with their schedules and run history`
      );
    }
    const result = await this.repository.dropTable(id);
    return { dropped: true, deletedSyncDefinitions: result.deletedSyncDefinitions };
  }

  async deleteBlueprint(id: string, confirmation: string): Promise<{ deleted: true }> {
    const existing = await this.repository.findById(id);
    if (!existing) throw new NotFoundException("Schema blueprint not found");
    if (confirmation !== existing.tableName) {
      throw new BadRequestException(`Type the table name ${existing.tableName} to confirm deletion`);
    }
    if (existing.status === "applied") {
      throw new BadRequestException("Drop the applied data table before deleting its blueprint");
    }
    const syncCount = await this.repository.syncDependencyCount(id);
    if (syncCount) throw new ConflictException(`Delete ${syncCount} sync definition(s) that use this blueprint first`);
    if (!await this.repository.deleteBlueprint(id)) throw new NotFoundException("Schema blueprint not found");
    return { deleted: true };
  }
}
