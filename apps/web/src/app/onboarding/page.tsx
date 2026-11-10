import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { OnboardingWizard } from "@/components/onboarding/wizard";
import { api, dataOrThrow } from "@/lib/api";
import { isInternalPath } from "@/lib/sign-in-path";

export const metadata: Metadata = { title: "Set up your account" };

// What the user sees after coming back from PayPal (?paypal=…). Plain words, and what to do next.
const NOTICES: Record<string, { tone: "good" | "warn" | "bad"; text: string }> = {
  linked: { tone: "good", text: "Your PayPal account is linked." },
  "seller-connected": { tone: "good", text: "PayPal confirmed you can receive payments." },
  "seller-pending": { tone: "warn", text: "PayPal has not confirmed your account yet. Finish the steps on PayPal, then check again; it can take a minute." },
  "seller-limited": { tone: "warn", text: "PayPal knows your account but cannot send it payments yet. Confirm your email on PayPal, then check again." },
  cancelled: { tone: "warn", text: "You left PayPal before finishing. You can try again whenever you are ready." },
  "state-mismatch": { tone: "bad", text: "That PayPal sign-in did not start here, so it was ignored. Start again from this page." },
  "link-failed": { tone: "bad", text: "PayPal did not confirm the connection. Try again in a moment." },
};

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ paypal?: string; next?: string }> }) {
  const { paypal, next: rawNext } = await searchParams;
  const next = rawNext !== undefined && isInternalPath(rawNext) ? rawNext : undefined;
  const me = dataOrThrow(await (await api()).GET("/me"));
  // Finished users only see this page once, right after the last step, to land on "Ready".
  if (me.onboarding.completed && paypal !== "done") redirect(next ?? "/dashboard");
  return <OnboardingWizard me={me} notice={paypal === undefined ? null : (NOTICES[paypal] ?? null)} next={next} />;
}
