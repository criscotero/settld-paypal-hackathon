import "server-only";
import type { ActionError } from "./problem";

// A fetch that never got an answer (Core API down, network cut) becomes an ActionError the
// form can show, instead of crashing the Server Action. Lives outside "use server" files:
// every async export there becomes an action the browser could call.
export async function reach<T>(call: () => Promise<T>): Promise<T | ActionError> {
  try {
    return await call();
  } catch (e) {
    if (e instanceof TypeError) {
      return { code: "INTERNAL", message: "Could not reach Core API. Your request may or may not have been applied; submitting again is safe.", issues: [], requestId: null };
    }
    throw e;
  }
}
