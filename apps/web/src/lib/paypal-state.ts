// Shared by the Server Action that starts Log in with PayPal and the route PayPal returns to.
// Not in actions.ts: a "use server" file may only export async functions.
export const PAYPAL_STATE_COOKIE = "settld_paypal_state";
