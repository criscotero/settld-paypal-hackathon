import type { ActionError } from "./problem";

// Shared by every Server Action file. Not in a "use server" file: there, every async export
// would become an action the browser could call.

export function field(fd: FormData, name: string): string {
  const v = fd.get(name);
  if (typeof v !== "string" || v === "") throw new Error(`Missing form field ${name}`);
  return v;
}

// Checkbox values are strings; anything else (a File) is not a value we sent.
export function strings(fd: FormData, name: string): string[] {
  return fd.getAll(name).filter((v): v is string => typeof v === "string");
}

// reach() returns an ActionError when Core API could not be reached.
export function isFailure(r: unknown): r is ActionError {
  return typeof r === "object" && r !== null && "code" in r && "message" in r && "issues" in r;
}
