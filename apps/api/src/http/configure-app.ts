import { RequestMethod } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { ProblemFilter } from "../errors/problem.filter.js";
import { requestIdMiddleware } from "./request-id.js";

// Shared by main.ts and the e2e tests, so tests run the same HTTP pipeline as production.
export function configureApp(app: INestApplication): void {
  // openapi.yaml: servers end in /v1. internal-api.yaml paths already carry /internal/v1.
  app.setGlobalPrefix("v1", { exclude: [{ path: "internal/v1/events", method: RequestMethod.POST }] });
  app.use(requestIdMiddleware);
  app.useGlobalFilters(new ProblemFilter());
}
