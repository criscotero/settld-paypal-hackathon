// Time as a dependency. The countdown, authorization expiry and window timers all compare
// against "now"; tests replace this with a clock they can move, instead of sleeping.
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol("CLOCK");

export const systemClock: Clock = { now: () => new Date() };

// The web app's base URL (SETTLD_WEB_URL), injected where PayPal needs a return address.
export const WEB_URL = Symbol("WEB_URL");
