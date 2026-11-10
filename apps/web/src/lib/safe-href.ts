// A link the seller wrote, about to be clicked by the person deciding on money. The API validates
// it is a URL, and javascript: is a URL. Only web addresses become links; anything else is shown
// as text, so the buyer can still read what was delivered.
export function safeHref(url: string): string | null {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}
