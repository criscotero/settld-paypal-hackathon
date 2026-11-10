import { randomUUID } from "node:crypto";
import { Catch, HttpException } from "@nestjs/common";
import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import type { Request, Response } from "express";
import type { RequestWithId } from "../http/request-id.js";
import { ProblemException } from "./problem.js";

// Turns every thrown error into application/problem+json (errors.md).
@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const problem = toProblem(exception);
    // errors.md: X-Request-Id is echoed or generated, and ends up in `requestId`.
    const requestId = (req as RequestWithId).requestId ?? req.header("x-request-id") ?? `req_${randomUUID()}`;
    const slug = problem.code.toLowerCase().replaceAll("_", "-");

    // errors.md: RATE_LIMITED says when to come back.
    const retryAfter = problem.context?.retryAfterSeconds;
    if (typeof retryAfter === "number") res.setHeader("Retry-After", String(retryAfter));
    res
      .status(problem.status)
      .type("application/problem+json")
      .json({
        type: `https://settld.app/errors/${slug}`,
        title: problem.title,
        status: problem.status,
        code: problem.code,
        detail: problem.detail,
        requestId,
        context: problem.context,
      });
  }
}

function toProblem(exception: unknown): ProblemException {
  if (exception instanceof ProblemException) return exception;
  // Malformed JSON never reaches a controller: the body parser rejects it with a 400.
  if (exception instanceof HttpException && exception.getStatus() === 400) {
    return new ProblemException("VALIDATION_FAILED", 422, "Some fields need fixing", "The request body is not valid JSON.");
  }
  // Multer's cap on an upload (delivery files, ADR-0020): the contract's code, not a 500.
  if (exception instanceof HttpException && exception.getStatus() === 413) {
    return new ProblemException("FILE_TOO_LARGE", 413, "The file is too large", "A delivery file can be at most 25 MB.");
  }
  // Nest raises its own 404 for unknown routes; map it to the contract's code.
  if (exception instanceof HttpException && exception.getStatus() === 404) {
    return new ProblemException("NOT_FOUND", 404, "We couldn't find that");
  }
  // Anything else is a bug until a milestone maps it to a code on purpose.
  // Never leak its message: it may contain internals. Log it so it isn't lost either.
  console.error(exception);
  return new ProblemException("INTERNAL", 500, "Something went wrong on our side. Try again.");
}
