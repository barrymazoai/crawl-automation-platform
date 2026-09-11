import { z } from "zod";

export const Id = z.uuid().transform((value) => value.toLowerCase());
const Revision = z.number().int().positive().max(2147483646);
const Name = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    "Name contains control characters",
  );
const Note = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => !value.includes("\0"));
export const CreateBrand = z.strictObject({
  name: Name,
  note: Note.default(""),
});
export const UpdateBrand = z.strictObject({
  name: Name,
  note: Note,
  revision: Revision,
});
const Url = z
  .string()
  .trim()
  .max(2000)
  .transform((value, ctx) => {
    try {
      if (/[\u0000-\u0020\u007f\\]/u.test(value))
        throw new Error("Invalid URL characters");
      const url = new URL(value);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        !url.hostname
      )
        throw new Error("Unsupported URL");
      url.hash = "";
      if (new TextEncoder().encode(url.href).byteLength > 2000)
        throw new Error("URL too long");
      return url.href;
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Provide an http/https URL without credentials",
      });
      return z.NEVER;
    }
  });
export const Channel = z.enum(["amazon", "gnc", "swanson", "dtc"]);
const SourceFields = {
  channel: Channel,
  region: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/)
    .default("US"),
  url: Url,
};
export const CreateSource = z.strictObject(SourceFields);
export const UpdateSource = z.strictObject({
  ...SourceFields,
  revision: Revision,
});
export const ToggleSource = z.strictObject({
  enabled: z.boolean(),
  revision: Revision,
});
export const ListQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
  q: z.string().trim().max(100).default(""),
});
// Wire format only. Database Date conversion belongs to the server adapter.
const Timestamp = z.iso.datetime({ offset: true });
export const Brand = z.strictObject({
  id: Id,
  name: z.string(),
  note: z.string(),
  revision: z.number().int().positive(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export const Source = z.strictObject({
  id: Id,
  brandId: Id,
  channel: Channel,
  region: z.string(),
  url: z.string(),
  enabled: z.boolean(),
  revision: z.number().int().positive(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Brand = z.infer<typeof Brand>;
export type Source = z.infer<typeof Source>;
export type CreateBrand = z.infer<typeof CreateBrand>;
export type UpdateBrand = z.infer<typeof UpdateBrand>;
export type CreateSource = z.infer<typeof CreateSource>;
export type UpdateSource = z.infer<typeof UpdateSource>;
export type ToggleSource = z.infer<typeof ToggleSource>;
export type ListQuery = z.infer<typeof ListQuery>;
export interface Page<T> {
  items: T[];
  limit: number;
  offset: number;
  hasMore: boolean;
}
export const Summary = z.strictObject({
  brands: z.number().int().nonnegative(),
  sources: z.number().int().nonnegative(),
  enabledSources: z.number().int().nonnegative(),
});
export type Summary = z.infer<typeof Summary>;
export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.strictObject({
    items: z.array(item),
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  });
export const ApiErrorResponse = z.strictObject({
  error: z.strictObject({ code: z.string(), message: z.string() }),
});
