export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 404 | 409 | 413 | 415 | 500 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function databaseError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof Error && "code" in error) {
    if (error.code === "23505")
      return new ApiError(
        409,
        "DUPLICATE",
        "A Brand name or source URL already exists.",
      );
    if (error.code === "23503")
      return new ApiError(404, "BRAND_NOT_FOUND", "Brand not found.");
    if (["40001", "40P01", "55P03", "57014"].includes(String(error.code)))
      return new ApiError(
        503,
        "DATABASE_BUSY",
        "Database busy; retry the same request ID.",
      );
    if (
      String(error.code).startsWith("08") ||
      ["ECONNREFUSED", "57P01", "57P03"].includes(String(error.code))
    )
      return new ApiError(
        503,
        "DATABASE_UNAVAILABLE",
        "Database temporarily unavailable.",
      );
  }
  return new ApiError(
    500,
    "INTERNAL_ERROR",
    "The request could not be completed.",
  );
}
