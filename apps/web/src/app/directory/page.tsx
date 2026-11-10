import { ChevronRight, Search, Users } from "lucide-react";
import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { PersonCard } from "@/components/person-card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { api, dataOrThrow, requireOnboardedMe } from "@/lib/api";
import { directoryHref, parseDirectoryQuery } from "@/lib/directory-query";
import { PROFESSION_LABELS, PROFESSIONS } from "@/lib/professions";

export const metadata: Metadata = { title: "Directory" };

// The filters live in the URL rather than in component state: a search can be shared or reopened,
// and the browser's back button returns to the previous page of results, which a forward-only cursor
// cannot do by itself.
export default async function DirectoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = parseDirectoryQuery(await searchParams);
  await requireOnboardedMe(directoryHref(query, query.cursor));
  const { items, nextCursor } = dataOrThrow(
    await (await api()).GET("/directory", {
      params: { query: { q: query.q === "" ? undefined : query.q, profession: query.profession === "" ? undefined : query.profession, cursor: query.cursor } },
    }),
  );
  const filtered = query.q !== "" || query.profession !== "";

  return (
    <div className="space-y-6">
      <PageHeader title="Directory" description="Sellers and collaborators who chose to be listed and can receive payments through PayPal." />

      {/* key: after a search, the fields must show the URL's values, not what React kept from before. */}
      <Form key={`${query.q}|${query.profession}`} action="/directory" className="flex flex-wrap gap-2">
        <div className="relative min-w-60 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <Input name="q" defaultValue={query.q} maxLength={80} aria-label="Search by name, headline or skill" placeholder="Name, headline or skill" className="pl-9" />
        </div>
        <Select name="profession" defaultValue={query.profession} aria-label="Profession" className="w-auto">
          <option value="">Any profession</option>
          {PROFESSIONS.map((p) => (
            <option key={p} value={p}>
              {PROFESSION_LABELS[p]}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="outline">
          Search
        </Button>
      </Form>

      {items.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 p-10 text-center">
          <Users className="size-6 text-slate-400" aria-hidden />
          {filtered ? (
            <>
              <p className="text-sm text-slate-600">No one matches this search.</p>
              <Link href="/directory" className={buttonVariants({ variant: "outline" })}>
                Clear filters
              </Link>
            </>
          ) : query.cursor !== undefined ? (
            <>
              <p className="text-sm text-slate-600">No one else to show.</p>
              <Link href="/directory" className={buttonVariants({ variant: "outline" })}>
                Back to the first page
              </Link>
            </>
          ) : (
            <>
              <p className="text-sm text-slate-600">No one is listed yet.</p>
              <Link href="/profile" className={buttonVariants({ variant: "outline" })}>
                Edit your profile
              </Link>
            </>
          )}
        </Card>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {items.map((person) => (
            <li key={person.userId}>
              <Card className="h-full p-5">
                {/* paypal: Core API lists only people whose PayPal account can receive payments. */}
                <PersonCard
                  name={person.displayName}
                  headline={person.headline ?? ""}
                  professions={person.professions.map((p) => PROFESSION_LABELS[p])}
                  skills={person.skills}
                  country={person.country ?? ""}
                  paypal
                />
              </Card>
            </li>
          ))}
        </ul>
      )}

      {nextCursor !== null && (
        <div className="flex justify-center">
          <Link href={directoryHref(query, nextCursor)} className={buttonVariants({ variant: "outline" })}>
            Next page <ChevronRight aria-hidden />
          </Link>
        </div>
      )}
    </div>
  );
}
