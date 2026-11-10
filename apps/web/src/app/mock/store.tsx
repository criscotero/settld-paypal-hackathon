"use client";
// State of the /mock prototype, kept in this browser (localStorage) so a reload or moving
// between pages keeps what was typed. Nothing reaches Core API.
import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { MILESTONE } from "./mock-data";

export interface Profile {
  name: string;
  headline: string;
  professions: string[];
  skills: string[];
  bio: string;
  link: string;
  inDirectory: boolean;
}

export interface TeamMember {
  // "me" is the seller filling the profile; the rest are DIRECTORY ids.
  personId: string;
  role: string;
  shareBps: number;
  status: "ACCEPTED" | "INVITED";
}

export type Verdict = "PASS" | "FAIL" | "NEEDS_HUMAN" | "CHECKING" | "WAITING";

export interface Release {
  seq: number;
  amountMinor: number;
  countedBps: number;
  countedIds: string[];
  final: boolean;
  at: string;
}

export type Stage = "APPROVED" | "FUNDED" | "IN_PROGRESS" | "VERIFYING" | "OBJECTION_WINDOW" | "PARTIALLY_RELEASED" | "RELEASED" | "CLOSED";

export interface Flow {
  stage: Stage;
  round: number;
  verdicts: Record<string, Verdict>;
  approvedByBuyer: string[];
  windowEndsAt: number | null;
  releases: Release[];
  log: { at: string; text: string }[];
}

export interface MockState {
  profile: Profile;
  team: TeamMember[];
  teamApproved: boolean;
  flow: Flow;
}

const INITIAL: MockState = {
  profile: { name: "Fede Seller", headline: "", professions: [], skills: [], bio: "", link: "", inDirectory: true },
  team: [{ personId: "me", role: "Lead developer", shareBps: 10_000, status: "ACCEPTED" }],
  teamApproved: false,
  flow: {
    stage: "APPROVED",
    round: 0,
    verdicts: Object.fromEntries(MILESTONE.criteria.map((c) => [c.id, "WAITING"])),
    approvedByBuyer: [],
    windowEndsAt: null,
    releases: [],
    log: [{ at: new Date().toISOString(), text: "Both parties approved version 1 of the contract." }],
  },
};

const KEY = "settld-mock-v1";

const Ctx = createContext<{ state: MockState; set: (update: (s: MockState) => MockState) => void; reset: () => void } | null>(null);

export function MockProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<MockState>(INITIAL);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved !== null) setState(JSON.parse(saved) as MockState);
    } catch {
      // Private window or blocked storage: the prototype still works, it just forgets.
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      // see above
    }
  }, [state, loaded]);

  return <Ctx.Provider value={{ state, set: setState, reset: () => { setState(INITIAL); } }}>{children}</Ctx.Provider>;
}

export function useMock() {
  const ctx = useContext(Ctx);
  if (ctx === null) throw new Error("useMock outside MockProvider");
  return ctx;
}

export function addLog(flow: Flow, text: string): Flow {
  return { ...flow, log: [{ at: new Date().toISOString(), text }, ...flow.log] };
}
