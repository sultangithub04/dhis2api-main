import "reflect-metadata";
import { config as loadEnvironment } from "dotenv";
import { fileURLToPath } from "node:url";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication
} from "@nestjs/platform-fastify";
import { AppModule } from "./app.module.js";
import { getConfig } from "./config.js";

loadEnvironment({
  path: fileURLToPath(new URL("../../../.env", import.meta.url))
});

async function bootstrap(): Promise<void> {
  const config = getConfig();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: config.NODE_ENV !== "test"
    })
  );

  app.setGlobalPrefix("api/v1");

  const localOrigins = new Set([
    config.WEB_ORIGIN,
    "http://localhost:5173",
    "http://127.0.0.1:5173"
  ]);

  app.enableCors({
    origin: [...localOrigins],
    credentials: true,
    exposedHeaders: ["Content-Disposition"]
  });

  app.enableShutdownHooks();

  await app.listen(config.PORT, "0.0.0.0");

  Logger.log(
    `API listening on port ${config.PORT}`,
    "Bootstrap"
  );
}

void bootstrap();