// openapi.yaml: components.schemas.Actor
export interface Actor {
  readonly type: "USER" | "SYSTEM" | "ADMIN";
  readonly id: string;
}
