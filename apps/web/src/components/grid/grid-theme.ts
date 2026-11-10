// One AG Grid setup for every grid in Settld (ADR-0017, ADR-0022), so the ledger, the AI audit, the
// reviewer queue, the countdown and the criteria editor look and behave as one product.
import { AllCommunityModule, ModuleRegistry, themeQuartz } from "ag-grid-community";

// Community only (ADR-0017, decision 1): MIT, no key, nothing that expires during judging.
// Registering twice is harmless, so every grid can import this file on its own.
ModuleRegistry.registerModules([AllCommunityModule]);

export const settldGridTheme = themeQuartz.withParams({
  accentColor: "#0f766e",
  headerBackgroundColor: "#f8fafc",
  borderColor: "#e2e8f0",
  fontFamily: "inherit",
  fontSize: 13,
  headerFontWeight: 600,
  wrapperBorderRadius: 12,
});

// For grids that always have rows (the criteria editor, who gets what): AG Grid reserves 150 px for
// the rows in autoHeight mode, room for its "no rows" message, which leaves a blank band under one
// or two rows. Not for grids that can be empty after a filter: there the message needs that room.
export const ALWAYS_HAS_ROWS = "[&_.ag-grid-scrolling-rows]:min-h-0!";
