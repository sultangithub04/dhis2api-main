import { Controller, Get, Inject, Param, ParseUUIDPipe, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { BackupService } from "./backup.service.js";

function sendJson(response: FastifyReply, result: { filename: string; payload: unknown }) {
  response.header("Content-Type", "application/json; charset=utf-8");
  response.header("Content-Disposition", `attachment; filename="${result.filename}"`);
  return result.payload;
}

function sendCsv(response: FastifyReply, result: { filename: string; content: string }) {
  response.header("Content-Type", "text/csv; charset=utf-8");
  response.header("Content-Disposition", `attachment; filename="${result.filename}"`);
  return result.content;
}

@Controller("backups")
export class BackupController {
  constructor(@Inject(BackupService) private readonly backups: BackupService) {}

  @Get("configuration.json")
  async configuration(@Res({ passthrough: true }) response: FastifyReply) {
    return sendJson(response, await this.backups.configuration());
  }

  @Get(":id/data.json")
  async data(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query("year") year: string | undefined,
    @Res({ passthrough: true }) response: FastifyReply
  ) {
    return sendJson(response, await this.backups.data(id, year));
  }

  @Get(":id/data.csv")
  async csv(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query("year") year: string | undefined,
    @Res({ passthrough: true }) response: FastifyReply
  ) {
    return sendCsv(response, await this.backups.csv(id, year));
  }

  @Get(":id/years")
  years(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.backups.years(id);
  }
}
