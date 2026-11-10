import { SearchX } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

// Core API answers 404 both for "does not exist" and "you are not a party"
// (errors.md, NOT_FOUND), so this page cannot say which one it was.
export default function NotFound() {
  return (
    <Card className="mx-auto max-w-lg p-8 text-center">
      <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-slate-100 text-slate-500">
        <SearchX className="size-6" aria-hidden />
      </div>
      <h1 className="mt-4 text-xl font-semibold">Not found</h1>
      <p className="mt-1 text-sm text-slate-500">It does not exist, or the user you are acting as is not a party to it.</p>
      <Link href="/contracts" className={`${buttonVariants({ variant: "outline" })} mt-6`}>
        Back to contracts
      </Link>
    </Card>
  );
}
