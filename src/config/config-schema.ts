import { z } from "zod";

export const modelMappingSchema = z.object({
  listen: z.string().trim().min(1, "listen model is required"),
  upstream: z.string().trim().min(1, "upstream model is required"),
});

export type ModelMapping = z.infer<typeof modelMappingSchema>;
