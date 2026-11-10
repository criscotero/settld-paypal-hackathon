import type { Schemas } from "./api-types";

export type Profession = Schemas["Profession"];

// openapi.yaml: Profession. The order is the order of the chips.
export const PROFESSION_LABELS: Record<Profession, string> = {
  SOFTWARE_DEVELOPER: "Software Developer",
  PRODUCT_DESIGNER: "Product Designer",
  AI_ENGINEER: "AI Engineer",
  DATA_ANALYST: "Data Analyst",
  QA_ENGINEER: "QA Engineer",
  PRODUCT_MANAGER: "Product Manager",
  COPYWRITER: "Copywriter",
  DEVOPS_ENGINEER: "DevOps Engineer",
  OTHER: "Other",
};

export const PROFESSIONS = Object.keys(PROFESSION_LABELS) as Profession[];
