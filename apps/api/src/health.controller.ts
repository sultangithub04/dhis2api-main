import { Controller, Get, Inject } from "@nestjs/common";
import { DatabaseService } from "./database/database.service.js";

@Controller("health")
export class HealthController {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  @Get()
  async health() {
    await this.database.query("SELECT 1");
    return { status: "ok", service: "dhis-sync-api", timestamp: new Date().toISOString() };
  }
}
