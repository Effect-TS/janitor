import * as SqlError from "effect/unstable/sql/SqlError"

/**
 * `SqlError.message` is a generic label such as "Failed to execute statement".
 * The driver's detail lives on the reason's cause; include it so operators can
 * see which constraint or syntax failed.
 */
export const describeError = (error: { readonly message: string }): string => {
  if (SqlError.isSqlError(error)) {
    const cause: unknown = error.reason.cause
    if (cause instanceof Error && cause.message.length > 0) {
      return `${error.message}: ${cause.message}`
    }
  }
  return error.message
}
