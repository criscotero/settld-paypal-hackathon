import type { Metadata } from "next";
import { ReviewerApplicationCard } from "@/components/reviewer-application-card";
import { requireOnboardedMe } from "@/lib/api";
import { ProfileEditor } from "./profile-editor";

export const metadata: Metadata = { title: "Your profile" };

// The professional profile after onboarding (ADR-0009): sellers and collaborators keep what they
// do up to date and decide whether to appear in the directory.
export default async function ProfilePage() {
  const me = await requireOnboardedMe("/profile");
  return (
    <div className="space-y-6">
      <ProfileEditor me={me} />
      <ReviewerApplicationCard application={me.reviewerApplication} hasRole={me.roles.includes("REVIEWER")} />
    </div>
  );
}
