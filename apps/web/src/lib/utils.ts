import { clsx } from "clsx";
import type { ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// shadcn/ui helper: later classes win over earlier ones (twMerge), so callers can override.
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
