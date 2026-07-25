import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

export const DEFAULT_ADMIN_HOST = "127.0.0.1";
export const DEFAULT_ADMIN_PORT = 18_080;
export const DEFAULT_APPLICATION_CONFIG_PATH = "llm-proxy.json";

const applicationConfigSchema = z.object({
  admin: z.object({
    host: z.string().trim().min(1),
    port: z.number().int().min(1).max(65_535),
  }),
});

// z.infer 让 TypeScript 类型直接来自运行时校验规则，避免维护两份容易漂移的定义。
export type ApplicationConfig = z.infer<typeof applicationConfigSchema>;

export function createDefaultApplicationConfig(): ApplicationConfig {
  return {
    admin: {
      host: DEFAULT_ADMIN_HOST,
      port: DEFAULT_ADMIN_PORT,
    },
  };
}

export async function loadApplicationConfig(configPath: string): Promise<ApplicationConfig> {
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    const config = createDefaultApplicationConfig();
    await mkdir(path.dirname(configPath), { recursive: true });
    try {
      // wx 表示“仅在文件不存在时创建”。如果两个进程同时首次启动，只有一个会成功，
      // 另一个会在 EEXIST 分支中读取胜出的文件，不会覆盖用户配置。
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      return config;
    } catch (writeError) {
      if (!isExistingFile(writeError)) throw writeError;
      text = await readFile(configPath, "utf8");
    }
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Application config is not valid JSON: ${configPath}`, { cause: error });
  }
  const result = applicationConfigSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Application config has an invalid schema: ${configPath}`, {
      cause: result.error,
    });
  }
  return result.data;
}

function isMissingFile(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value && value.code === "ENOENT";
}

function isExistingFile(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value && value.code === "EEXIST";
}
