import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";

// The ledger is where an auditor works: filters, a search, a selected row. A link out of it opens
// a new tab, so coming back does not mean rebuilding all of that.
//
// A plain target="_blank", on purpose. A window.open in onClick was tried and dropped: the desktop
// app's browser pane opens window.open only for other sites, as popups, and silently ignores it
// for Settld's own pages, so "Open contract" did nothing. A person's click on target="_blank"
// opens a new tab there and in every browser.
//
// A plain <a>, not next/link: a new tab loads the page from scratch, so client-side navigation
// and prefetching would buy nothing.
export function NewTabLink({ href, children, className = "", ariaLabel }: { href: string; children: ReactNode; className?: string; ariaLabel?: string }) {
  return (
    // noopener and noreferrer: another site must not be able to reach back into this tab, and the
    // contract id in our URL is nobody's business there. Harmless for our own pages.
    <a href={href} target="_blank" rel="noopener noreferrer" aria-label={ariaLabel === undefined ? undefined : `${ariaLabel} (opens in a new tab)`} className={`inline-flex items-center gap-1 text-primary hover:underline ${className}`}>
      {children}
      <ExternalLink className="size-3.5" aria-hidden />
      {ariaLabel === undefined && <span className="sr-only">(opens in a new tab)</span>}
    </a>
  );
}
