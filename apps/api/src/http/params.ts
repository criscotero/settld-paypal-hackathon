import { ProblemException } from "../errors/problem.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A malformed id in the path is "not found", not a 500 from Postgres failing to cast it.
export function uuidParam(value: string): string {
  if (!UUID.test(value)) throw notFound();
  return value;
}

export function notFound(): ProblemException {
  // errors.md: NOT_FOUND also covers "exists but you can't see it", so it never reveals existence.
  return new ProblemException("NOT_FOUND", 404, "We couldn't find that", "It doesn't exist or you don't have access to it.");
}
