/** Application error carrying an HTTP status and a stable machine-readable code.
 *  Serialized by app.ts as { error: { code, message } } (API.md). */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (message: string, code = 'bad_request') => new ApiError(400, code, message);
export const unauthorized = (message = 'authentication required', code = 'unauthorized') =>
  new ApiError(401, code, message);
export const forbidden = (message = 'insufficient role', code = 'forbidden') => new ApiError(403, code, message);
export const notFound = (message = 'not found', code = 'not_found') => new ApiError(404, code, message);
export const conflict = (message: string, code = 'conflict') => new ApiError(409, code, message);
export const gone = (message: string, code = 'gone') => new ApiError(410, code, message);
