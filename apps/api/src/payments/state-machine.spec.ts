// Contract conformance: the code's transition table is the YAML's, exactly.
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { assertAllowed, moneyEffect, TRANSITIONS } from "./state-machine.js";

interface YamlTransition {
  id: string;
  from: string[];
  to: string;
  event: string;
  actors: string[];
  guards: string[];
  effects: string[];
}
interface YamlMachine {
  transitions: YamlTransition[];
  moneyEffects: { "E-CAPTURE": string[]; "E-VOID": string[] };
}

const contract = parse(readFileSync(new URL("../../../../docs/contracts/milestone-state-machine.yaml", import.meta.url), "utf8")) as YamlMachine;

describe("state machine table vs milestone-state-machine.yaml", () => {
  it("has exactly the contract's transitions, with the same from, to, event, actors, guards and effects", () => {
    const code = TRANSITIONS.map((t) => ({ ...t, from: [...t.from], actors: [...t.actors], guards: [...t.guards], effects: [...t.effects] }));
    expect(code).toEqual(contract.transitions);
  });

  it("captures and voids only where the contract says (moneyEffects)", () => {
    expect(TRANSITIONS.filter((t) => moneyEffect(t.id) === "E-CAPTURE").map((t) => t.id)).toEqual(contract.moneyEffects["E-CAPTURE"]);
    expect(TRANSITIONS.filter((t) => moneyEffect(t.id) === "E-VOID").map((t) => t.id)).toEqual(contract.moneyEffects["E-VOID"]);
  });

  it("refuses a transition from a state the contract does not list", () => {
    expect(() => assertAllowed("SM-T08", "VERIFYING")).toThrow(expect.objectContaining({ code: "INVALID_TRANSITION" }));
    expect(assertAllowed("SM-T08", "OBJECTION_WINDOW").to).toBe("RELEASED");
  });
});
