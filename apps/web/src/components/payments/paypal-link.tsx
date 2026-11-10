import { NewTabLink } from "@/components/new-tab-link";

// The fact in the viewer's own PayPal account. Core API builds the URL (paypalUrl), because it
// depends on whose hold this is: the payee opens the capture, the buyer gets their activity
// searched by the id, since PayPal gives the buyer another id. Nothing is rendered without one.
export function PaypalLink({ url, label = "View in PayPal", className = "" }: { url: string | null | undefined; label?: string; className?: string }) {
  if (url === null || url === undefined) return null;
  // A new tab (NewTabLink): PayPal must never replace the Settld tab.
  return (
    <NewTabLink href={url} className={className}>
      {label}
    </NewTabLink>
  );
}

// For the buyer only. PayPal gives the buyer their own transaction id, which Settld never learns,
// so their link can only search their activity, not open the receipt itself. PayPal's own email
// does carry that receipt, so the buyer is told where the full one is.
export function BuyerPaypalNote({ className = "" }: { className?: string }) {
  return <p className={`text-xs text-slate-500 ${className}`}>The PayPal link finds this payment in your activity. PayPal also emailed you its own receipt for it.</p>;
}
