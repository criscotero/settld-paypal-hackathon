import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { MockNav } from "./mock-nav";
import { MockProvider } from "./store";

export const metadata: Metadata = { title: "Prototype" };

// A clickable prototype of the UI still to build: professional profile, team and split,
// live verification, release receipt. Mock data only; see the banner. A production build answers
// 404: made-up contracts and money must never look like a real user's.
export default function MockLayout({ children }: { children: ReactNode }) {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <MockProvider>
      <div className="space-y-6">
        <MockNav />
        {children}
      </div>
    </MockProvider>
  );
}
