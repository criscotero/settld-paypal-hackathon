"use client";
import { useActionState, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { newIdempotencyKey } from "@/lib/idempotency-key";
import type { ActionResult } from "@/lib/problem";
import { ErrorBox } from "./error-box";

type Props = {
  action: (prev: ActionResult, fd: FormData) => Promise<ActionResult>;
  submitLabel: string;
  variant?: "default" | "primary" | "outline" | "destructive";
  children?: ReactNode;
  className?: string;
};

// ADR-0005: the Idempotency-Key names this form's intent, not one click. It lives in
// client state, which survives router.refresh (AutoRefresh); a key rendered by the
// server would change every 5 seconds, and a retry after a refresh would become a
// second request. It rotates only after a success: the next submit is a new intent.
//
// Disabling the button while pending is a courtesy, not the guarantee: a retry after
// a network error resubmits the same form, and the key is what makes that safe.
export function ActionForm({ action, submitLabel, variant = "default", children, className }: Props) {
  const [key, setKey] = useState(newIdempotencyKey);
  const [error, formAction, pending] = useActionState(async (prev: ActionResult, fd: FormData) => {
    const result = await action(prev, fd);
    if (result === null) setKey(newIdempotencyKey());
    return result;
  }, null);
  return (
    <form action={formAction} className={className}>
      <input type="hidden" name="idempotencyKey" value={key} />
      {children}
      <Button type="submit" variant={variant} loading={pending} className="mt-3">
        {submitLabel}
      </Button>
      <ErrorBox error={error} />
    </form>
  );
}
