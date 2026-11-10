// Generated from docs/contracts/openapi.yaml (pnpm api:types). Never edit api-schema.d.ts
// by hand: a contract change is regenerated, and the compiler shows every screen it breaks.
import type { components, operations } from "./api-schema";

export type Schemas = components["schemas"];
export type Contract = Schemas["Contract"];
export type ContractSummary = Schemas["ContractSummary"];
export type ContractVersion = Schemas["ContractVersion"];
export type Milestone = Schemas["Milestone"];
export type DraftInput = Schemas["ContractDraftInput"];
export type User = Schemas["User"];
export type CriteriaSuggestion = operations["suggestCriteria"]["responses"]["200"]["content"]["application/json"];
export type PartyRole = Contract["myRole"];
