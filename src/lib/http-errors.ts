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
// 503, not 500: "ask again in a moment" rather than "this request is broken".
// The shop rules loader throws it when the restaurant's hours cannot be read,
// and everything that would take an order then fails closed.
export const serviceUnavailable = (msg = 'Service unavailable') =>
  new HttpError(503, msg);
