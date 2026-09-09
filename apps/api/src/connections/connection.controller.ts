import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query } from "@nestjs/common";
import { CreateConnectionSchema, type CreateConnectionInput, UpdateConnectionSchema, type UpdateConnectionInput } from "@dhis-sync/contracts";
import { ConnectionService } from "./connection.service.js";

function parseConnection(body: unknown): CreateConnectionInput {
  const parsed = CreateConnectionSchema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestException(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
    );
  }
  return parsed.data;
}

function parseUpdate(body: unknown): UpdateConnectionInput {
  const parsed = UpdateConnectionSchema.safeParse(body);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`));
  return parsed.data;
}

@Controller("connections")
export class ConnectionController {
  constructor(@Inject(ConnectionService) private readonly connections: ConnectionService) {}

  @Get()
  list() {
    return this.connections.list();
  }

  @Post("test")
  @HttpCode(200)
  testUnsaved(@Body() body: unknown) {
    return this.connections.testUnsaved(parseConnection(body));
  }

  @Post()
  create(@Body() body: unknown) {
    return this.connections.create(parseConnection(body));
  }

  @Put(":id")
  update(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    return this.connections.update(id, parseUpdate(body));
  }

  @Post(":id/test")
  @HttpCode(200)
  testSaved(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.connections.testSaved(id);
  }

  @Delete(":id")
  delete(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query("confirm") confirmation: string
  ) {
    return this.connections.delete(id, confirmation);
  }
}
