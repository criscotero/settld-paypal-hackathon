"use client";
import { RefreshCw, ServerCrash } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

// Catches failed reads (ApiError from dataOrThrow, or Core API down). Production
// builds hide server error messages from the browser and only send the digest,
// so the copy cannot depend on error.message.
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Card className="mx-auto max-w-lg p-8 text-center">
      <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-red-50 text-red-600">
        <ServerCrash className="size-6" aria-hidden />
      </div>
      <h1 className="mt-4 text-xl font-semibold">Something went wrong</h1>
      <p className="mt-1 text-sm text-slate-500">We could not load this page. Check that Core API is running, then try again.</p>
      <Button onClick={reset} className="mt-6">
        <RefreshCw aria-hidden /> Try again
      </Button>
      <p className="mt-4 font-mono text-xs text-slate-400">Reference: {error.digest ?? error.message}</p>
    </Card>
  );
}
