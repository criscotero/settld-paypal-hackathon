import { SetMetadata } from "@nestjs/common";

// Marks a route called by another Settld service, never by a person (internal-api.yaml). The
// user AuthGuard lets it through, and the route checks the service token itself (SB-7): a
// Clerk session must never open an internal route, and a service token never a public one.
export const SERVICE_ROUTE = "settld:service-route";
export const ServiceRoute = () => SetMetadata(SERVICE_ROUTE, true);
