import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { Card } from "@/components/ui/card";

const STEPS = [
  { href: "/mock/profile", title: "Professional profile", body: "During onboarding a seller says what they do: headline, professions, skills, and whether to appear in the directory." },
  { href: "/mock/team", title: "Team and split", body: "The seller finds collaborators in the directory, gives each a role and a share, and sends the team to the buyer for approval." },
  { href: "/mock/contract", title: "Live contract", body: "Fund with PayPal, deliver, watch each criterion get verified, and see the countdown release what counts, split across the team." },
  { href: "/mock/receipt", title: "Release receipt", body: "One page with what was verified, what was paid to whom, what is still held, and why." },
];

export default function MockHome() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">The rest of the UI, as a working prototype</h1>
        <p className="mt-1 max-w-2xl text-slate-600">Walk through it in order. Each step uses what you did in the previous one.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {STEPS.map((s, i) => (
          <Link key={s.href} href={s.href} className="group">
            <Card className="h-full p-5 transition-shadow group-hover:shadow-md">
              <p className="text-xs font-bold text-primary">Step {i + 1}</p>
              <h2 className="mt-1 font-semibold">{s.title}</h2>
              <p className="mt-1 text-sm text-slate-600">{s.body}</p>
              <p className="mt-3 flex items-center gap-1 text-sm font-semibold text-primary">
                Open <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
              </p>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
