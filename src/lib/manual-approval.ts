import { affiliateRevenueOf } from './analytics';
import { leadTag, manualMarker } from './qmp-sync';
import { shareOn, type ShareRate } from './settings';
import type { CpaRate } from './types';

/**
 * Approving a lead by hand, from the leads list.
 *
 * The admin picks the card the lead was approved for off the rate card, and
 * the approval is written at what that card pays, in the same shape the report
 * sync writes one in. When QMP reports the approval itself, the sync swaps the
 * hand-recorded one for QMP's (see planManualSwaps in lib/qmp-sync).
 *
 * Pure and client-safe: the approve form reads the choices and the cut from
 * here, and the route writes the notes from here, so the two cannot disagree.
 */

/** One card an approval can be for, and what each of its tiers pays. */
export type RateChoice = {
  issuer: string;
  card: string;
  /** One untiered rate (`tier: ''`), or one per tier in rate-card order. */
  tiers: { tier: string; amount: number }[];
};

/**
 * The rate card as the cards an approval can be for.
 *
 * A rate of "-" is not a rate, so a tier without one is left out and a card
 * with none at all is not offered: there is no amount to fill in. A card at $0
 * stays: it has been switched off, and an approval for it still happened.
 */
export function rateChoices(rows: CpaRate[]): RateChoice[] {
  const choices: RateChoice[] = [];
  const byKey = new Map<string, RateChoice>();
  for (const row of rows) {
    if (row.current === null) continue;
    const key = `${row.issuer}\u0000${row.card}`;
    let choice = byKey.get(key);
    if (!choice) {
      choice = { issuer: row.issuer, card: row.card, tiers: [] };
      byKey.set(key, choice);
      choices.push(choice);
    }
    choice.tiers.push({ tier: row.tier, amount: row.current });
  }
  return choices;
}

/**
 * What picking a card, and a tier where it has them, fills the amount in with.
 * Null when there is nothing to fill in yet: no card, or a tiered card with no
 * tier picked, which is a question still open rather than a rate of zero.
 */
export function amountFor(choice: RateChoice | undefined, tier: string): number | null {
  if (!choice) return null;
  const found = choice.tiers.find((entry) => entry.tier === tier);
  return found ? found.amount : null;
}

/**
 * Which card the approve form starts on: the first card the lead is on record
 * as applying for that the rate card has, or -1 for none. The sync writes the
 * card as QMP spells it, and the rate card comes from QMP too, so the two are
 * the same name give or take case and spacing.
 */
export function preselectChoice(leadCard: string, choices: RateChoice[]): number {
  const same = (value: string) => value.trim().toLowerCase();
  for (const name of (leadCard ?? '').split(',')) {
    if (!name.trim()) continue;
    const index = choices.findIndex((choice) => same(choice.card) === same(name));
    if (index !== -1) return index;
  }
  return -1;
}

/**
 * What the affiliate keeps of an approval: their share at the rate in force on
 * the day it was approved, which is how every figure on the dashboard values it.
 */
export function affiliateCut(amount: number, approvedOn: string, shares: ShareRate[]): number {
  return affiliateRevenueOf(amount, shareOn(approvedOn, shares));
}

/**
 * The notes on a hand-recorded approval: card, marker, lead tag, the order the
 * sync writes a synced one in. The card is where the lead's card is read back
 * from, the marker is what the sync finds it by, and the lead tag is what makes
 * the lead read approved.
 */
export function manualApprovalNotes(card: string, leadRef: string, id: string): string {
  return [card.trim(), manualMarker(id), leadTag(leadRef)].join(' · ');
}

/**
 * What the sync screen says about approvals recorded by hand, or '' when the
 * report meets none. A plan says what will happen and a run what did, so the
 * admin sees before writing that an amount they typed is about to change.
 */
export function manualSwapNote(
  sync: { manualToReplace: number; manualKept: number; replaced?: number },
  applied: boolean,
): string {
  const sentences: string[] = [];
  const replacing = applied ? (sync.replaced ?? 0) : sync.manualToReplace;
  if (replacing > 0) {
    sentences.push(
      `${replacing} approval${replacing === 1 ? '' : 's'} recorded by hand ${
        applied ? (replacing === 1 ? 'was' : 'were') : 'will be'
      } replaced by QMP's, at what QMP paid.`,
    );
  }
  if (sync.manualKept > 0) {
    sentences.push(
      replacing > 0
        ? `${sync.manualKept} ${sync.manualKept === 1 ? 'is' : 'are'} on a payout request, so ${
            sync.manualKept === 1 ? 'it stays' : 'they stay'
          } and QMP's ${sync.manualKept === 1 ? 'is' : 'are'} not written.`
        : `${sync.manualKept} QMP approval${sync.manualKept === 1 ? ' matches an approval' : 's match approvals'} recorded by hand that ${
            sync.manualKept === 1 ? 'is' : 'are'
          } on a payout request, so ${sync.manualKept === 1 ? 'that stays' : 'those stay'} and QMP's ${
            sync.manualKept === 1 ? 'is' : 'are'
          } not written.`,
    );
  }
  return sentences.join(' ');
}
