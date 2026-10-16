/**
 * What a PR review log says about an error: its category, and the operation
 * and status when it has them. Never its message, which can carry GitHub's
 * response text, provider bodies or pull request content (EFF-1641).
 */
export const errorFields = (error: unknown): Record<string, string | number> => {
  if (typeof error !== "object" || error === null) return { error: typeof error }
  const fields: Record<string, string | number> = {
    error:
      "_tag" in error && typeof error._tag === "string"
        ? error._tag
        : error instanceof Error
          ? error.name
          : "unknown",
  }
  if ("operation" in error && typeof error.operation === "string")
    fields["operation"] = error.operation
  if ("status" in error && typeof error.status === "number") fields["status"] = error.status
  return fields
}
