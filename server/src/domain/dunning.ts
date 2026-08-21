// The dunning (failed-payment recovery) schedule and state machine, kept
// pure so the "when do we retry, and when do we give up" policy is testable
// without a database, a clock, or a payment gateway. The service that acts
// on these decisions lives in src/services/dunning.service.ts.

// SQLite has no native enum type (see prisma/schema.prisma), so
// DunningCampaign's `status` and DunningAttempt's `outcome` columns are
// plain strings. These tuples are the single source of truth for the valid
// values, consumed by Zod schemas (z.enum) and anywhere else that needs the
// allowed set at runtime.
export const DUNNING_STATUSES = ['SCHEDULED', 'RECOVERED', 'EXHAUSTED', 'CANCELED'] as const;
export type DunningStatus = (typeof DUNNING_STATUSES)[number];

export const DUNNING_ATTEMPT_OUTCOMES = ['SUCCEEDED', 'FAILED', 'SKIPPED'] as const;
export type DunningAttemptOutcome = (typeof DUNNING_ATTEMPT_OUTCOMES)[number];

// Days after the campaign started at which each retry becomes due. Three
// retries spread over a week is the shape the roadmap specifies for Day 8:
// early enough to catch a card that was temporarily declined, spread out
// enough that a customer has time to fix it. The array length *is* the
// attempt budget — adding a fourth number here is the only change needed to
// add a fourth retry.
export const DUNNING_RETRY_OFFSET_DAYS = [1, 3, 7] as const;

export const MAX_DUNNING_ATTEMPTS = DUNNING_RETRY_OFFSET_DAYS.length;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Terminal statuses have no outgoing edges: once a campaign has recovered,
// been exhausted, or been called off (the invoice was voided or paid by
// other means), it is history and never resumes. The unique invoiceId in
// prisma/schema.prisma deliberately keeps a second campaign from being
// opened for the same invoice — recovery is a one-shot process per invoice.
const ALLOWED_TRANSITIONS: Record<DunningStatus, readonly DunningStatus[]> = {
  SCHEDULED: ['RECOVERED', 'EXHAUSTED', 'CANCELED'],
  RECOVERED: [],
  EXHAUSTED: [],
  CANCELED: [],
};

export function canTransitionDunningStatus(from: DunningStatus, to: DunningStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isTerminalDunningStatus(status: DunningStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}

// The full retry schedule for a campaign started at `startedAt`, as
// absolute instants. Offsets are added in whole milliseconds rather than
// via calendar arithmetic (src/domain/subscription.ts#addInterval) because
// a dunning retry is a "wait N x 24h" delay, not a billing period — it
// shouldn't shift by an hour across a daylight-saving boundary.
export function dunningAttemptSchedule(startedAt: Date): Date[] {
  return DUNNING_RETRY_OFFSET_DAYS.map((days) => new Date(startedAt.getTime() + days * MS_PER_DAY));
}

// When the next retry is due for a campaign that has already made
// `attemptsMade` attempts, or null when the attempt budget is spent (the
// caller should then move the campaign to EXHAUSTED). `attemptsMade` is a
// count, not an index: 0 attempts made means "the first retry is next".
export function nextDunningAttemptAt(startedAt: Date, attemptsMade: number): Date | null {
  if (!Number.isInteger(attemptsMade) || attemptsMade < 0) {
    throw new Error('attemptsMade must be a non-negative integer');
  }

  const offsetDays = DUNNING_RETRY_OFFSET_DAYS[attemptsMade];
  if (offsetDays === undefined) {
    return null;
  }

  return new Date(startedAt.getTime() + offsetDays * MS_PER_DAY);
}

export function isDunningExhausted(attemptsMade: number): boolean {
  return attemptsMade >= MAX_DUNNING_ATTEMPTS;
}

// How many retries are left in the budget, floored at 0 so an
// over-attempted campaign (only reachable if the schedule shrinks between
// deploys) reports "none left" rather than a negative number.
export function remainingDunningAttempts(attemptsMade: number): number {
  return Math.max(0, MAX_DUNNING_ATTEMPTS - attemptsMade);
}

export interface DunningDecision {
  /** Whether the campaign should run a retry right now. */
  shouldAttempt: boolean;
  /** The status the campaign should hold after this decision is applied. */
  status: DunningStatus;
  /** When the following retry becomes due, or null if none remains. */
  nextAttemptAt: Date | null;
}

export interface DunningCampaignState {
  startedAt: Date;
  attemptsMade: number;
  nextAttemptAt: Date | null;
}

// Decides what a SCHEDULED campaign should do at instant `now`. Splitting
// this out from the service keeps the "is it time yet / is the budget
// spent" reasoning in one pure place: the service only has to persist the
// decision and, when shouldAttempt is true, actually charge the invoice.
export function decideNextDunningStep(campaign: DunningCampaignState, now: Date): DunningDecision {
  if (isDunningExhausted(campaign.attemptsMade)) {
    return { shouldAttempt: false, status: 'EXHAUSTED', nextAttemptAt: null };
  }

  const dueAt =
    campaign.nextAttemptAt ?? nextDunningAttemptAt(campaign.startedAt, campaign.attemptsMade);
  if (dueAt && dueAt.getTime() > now.getTime()) {
    return { shouldAttempt: false, status: 'SCHEDULED', nextAttemptAt: dueAt };
  }

  return { shouldAttempt: true, status: 'SCHEDULED', nextAttemptAt: dueAt };
}

// Applies a retry's outcome to the campaign, returning the state it should
// be persisted with. A success recovers the campaign immediately; a failure
// either schedules the next retry or exhausts the budget, and an exhausted
// campaign is what tells the service to cancel the subscription.
export function applyDunningAttemptOutcome(
  campaign: { startedAt: Date; attemptsMade: number },
  outcome: DunningAttemptOutcome,
): DunningDecision {
  if (outcome === 'SUCCEEDED') {
    return { shouldAttempt: false, status: 'RECOVERED', nextAttemptAt: null };
  }

  const attemptsMade = campaign.attemptsMade + 1;
  const nextAttemptAt = nextDunningAttemptAt(campaign.startedAt, attemptsMade);
  if (!nextAttemptAt) {
    return { shouldAttempt: false, status: 'EXHAUSTED', nextAttemptAt: null };
  }

  return { shouldAttempt: false, status: 'SCHEDULED', nextAttemptAt };
}
