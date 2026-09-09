import { Module } from "@nestjs/common";
import { MetadataModule } from "../metadata/metadata.module.js";
import { SchemaController } from "./schema.controller.js";
import { SchemaRepository } from "./schema.repository.js";
import { SchemaService } from "./schema.service.js";

@Module({
  imports: [MetadataModule],
  controllers: [SchemaController],
  providers: [SchemaRepository, SchemaService],
  exports: [SchemaRepository, SchemaService]
})
export class SchemaModule {}

