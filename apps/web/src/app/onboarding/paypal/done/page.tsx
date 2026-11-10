"use client";
import { CircleCheck } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { isPaypalOutcome, onboardingPath, PAYPAL_CHANNEL } from "@/lib/paypal-return";

// Where the PayPal tab ends (lib/paypal-return.ts). It tells the Settld tab the outcome and
// closes itself. A browser only lets a script close a tab a script opened; when this page was
// reached any other way (the popup was blocked and PayPal ran in the Settld tab itself), close()
// does nothing and the page moves on to onboarding here instead.
function Done() {
  const router = useRouter();
  const raw = useSearchParams().get("paypal");
  const outcome = isPaypalOutcome(raw) ? raw : "link-failed";

  useEffect(() => {
    const channel = new BroadcastChannel(PAYPAL_CHANNEL);
    channel.postMessage({ outcome });
    channel.close();
    window.close();
    const stay = window.setTimeout(() => {
      router.replace(onboardingPath(outcome));
    }, 400);
    return () => {
      window.clearTimeout(stay);
    };
  }, [outcome, router]);

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
      <CircleCheck className="size-10 text-emerald-600" aria-hidden />
      <h1 className="text-xl font-bold text-navy">Back from PayPal</h1>
      <p className="text-sm text-slate-600">Your Settld tab has been updated. You can close this tab.</p>
      <Link href={onboardingPath(outcome)} className="text-sm font-semibold text-primary underline">
        Continue setting up your account
      </Link>
    </div>
  );
}

export default function PaypalDonePage() {
  return (
    <Suspense>
      <Done />
    </Suspense>
  );
}
