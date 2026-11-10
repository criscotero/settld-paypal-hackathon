"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/dashboard", label: "Dashboard", match: (p: string) => p.startsWith("/dashboard") },
  { href: "/contracts", label: "Contracts", match: (p: string) => p === "/contracts" || (p.startsWith("/contracts/") && p !== "/contracts/new" && !p.startsWith("/contracts/open")) },
  { href: "/contracts/new", label: "New contract", match: (p: string) => p === "/contracts/new" },
  { href: "/contracts/open", label: "Open projects", match: (p: string) => p.startsWith("/contracts/open") },
  { href: "/payments", label: "Payments", match: (p: string) => p.startsWith("/payments") },
  { href: "/invitations", label: "Invitations", match: (p: string) => p.startsWith("/invitations") },
  { href: "/directory", label: "Directory", match: (p: string) => p.startsWith("/directory") },
  { href: "/profile", label: "Profile", match: (p: string) => p === "/profile" },
];

// Client component only to know the current path for the active underline.
export function MainNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="-mb-px flex gap-4 overflow-x-auto text-sm font-medium sm:gap-6">
      {LINKS.map((l) => {
        const active = l.match(pathname);
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "border-b-2 py-3 whitespace-nowrap transition-colors",
              active ? "border-accent text-white" : "border-transparent text-white/60 hover:text-white",
            )}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}

const VISITOR_LINKS = [
  { href: "/#products", label: "Products" },
  { href: "/#benefits", label: "Benefits" },
  { href: "/#faq", label: "FAQs" },
];

// What a signed-out visitor sees: jumps to the home page sections instead of app pages they
// cannot use yet. Hidden on narrow screens, where Sign in and Sign up need the room.
export function VisitorNav() {
  return (
    <nav aria-label="Main" className="-mb-px hidden gap-6 text-sm font-medium sm:flex">
      {VISITOR_LINKS.map((l) => (
        <Link key={l.href} href={l.href} className="border-b-2 border-transparent py-3 whitespace-nowrap text-white/60 transition-colors hover:text-white">
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
