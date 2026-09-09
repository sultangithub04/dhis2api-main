import { Controller, Get, Inject, Param, ParseUUIDPipe, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { ReportService } from "./report.service.js";

@Controller("reports")
export class ReportController {
  constructor(@Inject(ReportService) private readonly reports: ReportService) {}

  @Get() list() { return this.reports.list(); }

  @Get(":id/data")
  data(@Param("id", new ParseUUIDPipe()) id: string, @Query() query: Record<string, string | undefined>) {
    return this.reports.data(id, query);
  }

  @Get(":id/export.csv")
  async csv(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query() query: Record<string, string | undefined>,
    @Res({ passthrough: true }) response: FastifyReply
  ) {
    const result = await this.reports.csv(id, query);
    response.header("Content-Type", "text/csv; charset=utf-8");
    response.header("Content-Disposition", `attachment; filename="${result.filename}"`);
    return result.content;
  }
}
