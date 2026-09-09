import { Module } from "@nestjs/common";
import { ConnectionModule } from "./connections/connection.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { HealthController } from "./health.controller.js";
import { MetadataModule } from "./metadata/metadata.module.js";
import { SchemaModule } from "./schema/schema.module.js";
import { SyncModule } from "./sync/sync.module.js";
import { ReportModule } from "./reports/report.module.js";
import { BackupModule } from "./backups/backup.module.js";

@Module({
  imports: [DatabaseModule, ConnectionModule, MetadataModule, SchemaModule, SyncModule, ReportModule, BackupModule],
  controllers: [HealthController]
})
export class AppModule {}
