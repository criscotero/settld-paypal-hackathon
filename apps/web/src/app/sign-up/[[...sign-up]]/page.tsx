import { SignUp } from "@clerk/nextjs";
import { onboardingEntry } from "@/lib/sign-in-path";

// Catch-all route: Clerk's component handles its own sub-steps (/sign-up/verify-email-address, ...).
// forceRedirectUrl: a new account always goes to onboarding, like the header and home buttons.
// Without it Clerk returns to "/" and the user lands on the home page with no role and no PayPal.
// redirect_url is where they were going (an invitation link, say): onboarding ends there.
export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ redirect_url?: string }> }) {
  const { redirect_url: next } = await searchParams;
  return (
    <div className="flex justify-center py-12">
      <SignUp forceRedirectUrl={onboardingEntry(next)} />
    </div>
  );
}
