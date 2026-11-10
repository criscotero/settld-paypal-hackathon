import { SignIn } from "@clerk/nextjs";

// Catch-all route: Clerk's component handles its own sub-steps (/sign-in/factor-one, ...).
// The dashboard sends anyone who has not finished onboarding back to it, so one target covers
// both. A fallback, not a force: a sign-in started from a protected page returns there.
export default function SignInPage() {
  return (
    <div className="flex justify-center py-12">
      <SignIn fallbackRedirectUrl="/dashboard" />
    </div>
  );
}
