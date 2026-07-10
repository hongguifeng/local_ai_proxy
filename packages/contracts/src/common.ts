import { z } from "zod";

export const EntityIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "ID contains unsupported characters");

export const TimestampSchema = z.iso.datetime({ offset: true });

export const PaginationSchema = z.strictObject({
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).max(10_000_000).default(0),
});

export const ErrorDetailSchema = z.strictObject({
  path: z.array(z.union([z.string(), z.number().int()])).optional(),
  message: z.string().min(1).max(1_000),
});

export const ApiErrorSchema = z.strictObject({
  code: z.string().min(1).max(80),
  message: z.string().min(1).max(1_000),
  details: z.array(ErrorDetailSchema).max(100).optional(),
});

export const ErrorEnvelopeSchema = z.strictObject({
  error: ApiErrorSchema,
  requestId: EntityIdSchema,
});

export type EntityId = z.infer<typeof EntityIdSchema>;
export type Timestamp = z.infer<typeof TimestampSchema>;
export type Pagination = z.infer<typeof PaginationSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
