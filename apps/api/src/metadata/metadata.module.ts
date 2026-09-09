import { Module } from "@nestjs/common";
import { ConnectionModule } from "../connections/connection.module.js";
import { MetadataController } from "./metadata.controller.js";
import { MetadataRepository } from "./metadata.repository.js";
import { MetadataService } from "./metadata.service.js";

@Module({
  imports: [ConnectionModule],
  controllers: [MetadataController],
  providers: [MetadataRepository, MetadataService],
  exports: [MetadataRepository, MetadataService]
})
export class MetadataModule {}

