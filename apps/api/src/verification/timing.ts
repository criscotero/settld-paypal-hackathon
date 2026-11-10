// Run timing (NFR-10, events.md 3.1). Shared by the submit transaction, which schedules the
// watchdog, and the dispatch, which tells the Engine its deadline: both count from the delivery.
export const RUN_DEADLINE_MS = 5 * 60_000;
// The watchdog looks 10 minutes after the deadline: by then the Engine has finished the run and
// its outbox has had time to deliver, so a run still unapplied means the event was lost.
export const WATCHDOG_AFTER_MS = RUN_DEADLINE_MS + 10 * 60_000;
