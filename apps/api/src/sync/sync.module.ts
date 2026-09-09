import { Module } from "@nestjs/common";
import { ConnectionModule } from "../connections/connection.module.js";
import { SyncController } from "./sync.controller.js";
import { SyncRepository } from "./sync.repository.js";
import { SyncService } from "./sync.service.js";

@Module({
  imports: [ConnectionModule],
  controllers: [SyncController],
  providers: [SyncRepository, SyncService],
  exports: [SyncService]
})
export class SyncModule {}
