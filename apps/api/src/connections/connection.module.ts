import { Module } from "@nestjs/common";
import { SecretCipherService } from "../security/secret-cipher.service.js";
import { ConnectionController } from "./connection.controller.js";
import { ConnectionRepository } from "./connection.repository.js";
import { ConnectionService } from "./connection.service.js";

@Module({
  controllers: [ConnectionController],
  providers: [ConnectionRepository, ConnectionService, SecretCipherService],
  exports: [ConnectionService]
})
export class ConnectionModule {}
