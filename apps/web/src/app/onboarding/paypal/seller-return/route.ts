import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { checkSellerConnect } from "@/app/onboarding/actions";
import { donePath } from "@/lib/paypal-return";
import { publicUrl } from "@/lib/public-url";

// Where PayPal sends a seller after partner onboarding, in the tab the wizard opened for it.
// PayPal appends merchantIdInPayPal and other parameters; they are ignored on purpose. Core API
// asks PayPal directly which merchant finished onboarding for this user (tracking_id), because
// a query string can be typed by anyone.
export async function GET(req: NextRequest) {
  return NextResponse.redirect(publicUrl(req, donePath(await checkSellerConnect())));
}
