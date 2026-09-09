import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query } from "@nestjs/common";
import { CreateSyncDefinitionSchema, type CreateSyncDefinitionInput, UpdateSyncDefinitionSchema, type UpdateSyncDefinitionInput, UpsertScheduleSchema, type UpsertScheduleInput } from "@dhis-sync/contracts";
import { SyncService } from "./sync.service.js";

function parseCreate(body: unknown): CreateSyncDefinitionInput {
  const result = CreateSyncDefinitionSchema.safeParse(body);
  if (!result.success) throw new BadRequestException(result.error.issues.map((issue) => issue.message));
  return result.data;
}

function parseSchedule(body: unknown): UpsertScheduleInput {
  const result = UpsertScheduleSchema.safeParse(body);
  if (!result.success) throw new BadRequestException(result.error.issues.map((issue) => issue.message));
  return result.data;
}

function parseUpdate(body: unknown): UpdateSyncDefinitionInput {
  const result = UpdateSyncDefinitionSchema.safeParse(body);
  if (!result.success) throw new BadRequestException(result.error.issues.map((issue) => issue.message));
  return result.data;
}

@Controller("sync-definitions")
export class SyncController {
  constructor(@Inject(SyncService) private readonly sync: SyncService) {}

  @Get() list() { return this.sync.list(); }
  @Post() create(@Body() body: unknown) { return this.sync.create(parseCreate(body)); }
  @Put(":id") update(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: unknown) { return this.sync.update(id, parseUpdate(body)); }
  @Post(":id/run") @HttpCode(200) run(@Param("id", new ParseUUIDPipe()) id: string) { return this.sync.run(id); }
  @Put(":id/schedule") schedule(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    return this.sync.schedule(id, parseSchedule(body));
  }
  @Delete(":id/schedule") deleteSchedule(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.sync.deleteSchedule(id);
  }
  @Delete(":id/runs") clearRuns(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.sync.clearRuns(id);
  }
  @Delete(":id") delete(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query("confirm") confirmation: string
  ) {
    return this.sync.delete(id, confirmation);
  }
}
