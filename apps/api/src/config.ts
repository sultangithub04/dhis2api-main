import { z } from "zod";

const EnvironmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  PORT: z.coerce
    .number()
    .int()
    .positive()
    .default(4000),

  DATABASE_URL: z.string().min(1),

  CONNECTION_ENCRYPTION_KEY: z.string().min(1),

  WEB_ORIGIN: z.string().default("http://localhost:5173"),
});

export type AppConfig = z.infer<typeof EnvironmentSchema>;

let cachedConfig: AppConfig | undefined;

export function getConfig(): AppConfig {
  cachedConfig ??= EnvironmentSchema.parse(process.env);
  return cachedConfig;
}