// A small typed HTTP error so routes can `throw new HttpError(404, '…')` and the
// global handler turns it into a clean `{ error }` JSON body — the shape the
// mobile app's api client already expects (see mobile/src/lib/api.ts).
export class HttpError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const badRequest = (msg = 'Bad request') => new HttpError(400, msg);
export const unauthorized = (msg = 'Unauthorized') => new HttpError(401, msg);
export const conflict = (msg = 'Conflict') => new HttpError(409, msg);
