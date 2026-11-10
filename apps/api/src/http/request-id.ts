import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export type RequestWithId = Request & { requestId?: string };

// errors.md: X-Request-Id is echoed or generated. It ends up in problem bodies, audit rows and
// as the correlationId of every event the request causes, so one id follows the whole chain.
export function requestIdMiddleware(req: RequestWithId, res: Response, next: NextFunction): void {
  const incoming = req.header("x-request-id");
  // Bounded and printable: the value lands in logs and audit rows.
  const id = incoming !== undefined && /^[\w.:-]{1,128}$/.test(incoming) ? incoming : `req_${randomUUID()}`;
  req.requestId = id;
  res.setHeader("X-Request-Id", id);
  next();
}

export function requestIdOf(req: Request): string {
  return (req as RequestWithId).requestId ?? `req_${randomUUID()}`;
}
