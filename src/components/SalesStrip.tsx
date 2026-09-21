import { formatMoney, formatPercent, salesFigures, type EarningsView } from '@/lib/analytics';

/**
 * The sales figures for the window on screen: how many sales, what they paid,
 * the affiliates' share, and what is kept.
 *
 * Read across, not one at a time, which is why it is one strip rather than
 * four cards. An affiliate gets the count and their own share only, because
 * the payout and the house's cut are not theirs to see anywhere else either.
 * Shared by the dashboard and each person's page, so the two cannot describe
 * the same month differently.
 */
export function SalesStrip({
  totals,
  gross,
  windowLabel,
}: {
  totals: EarningsView['totals'];
  gross: boolean;
  /** "30 days", "September 2026": said when there are no visits to count against. */
  windowLabel: string;
}) {
  const figures = salesFigures(totals, gross);
  return (
    <section
      className={`rise panel mt-5 grid grid-cols-1 ${
        gross ? 'sm:grid-cols-2 lg:grid-cols-4' : 'sm:grid-cols-2'
      }`}
    >
      <Kpi
        label="Sales"
        value={figures.sales.toLocaleString()}
        unit={
          totals.visits > 0
            ? `${formatPercent(totals.approvalRate, 1)} of ${totals.visits.toLocaleString()} visits`
            : `in ${windowLabel}`
        }
        plain="Approvals the merchant agreed to pay for."
        edge={gross ? 'first' : 'half'}
      />
      {figures.payout !== null ? (
        <Kpi
          label="Payout"
          value={formatMoney(figures.payout)}
          unit=""
          plain="What QMP paid for those sales."
          edge="second"
          delay={40}
        />
      ) : null}
      <Kpi
        label={gross ? 'Affiliate share' : 'Your share'}
        value={formatMoney(figures.share)}
        unit=""
        plain={
          gross
            ? 'What affiliates earn from them, at the rate on each approval day.'
            : 'What you earn from them.'
        }
        edge={gross ? 'third' : 'last'}
        delay={80}
      />
      {figures.keep !== null ? (
        <Kpi
          label="Company Keep"
          value={formatMoney(figures.keep)}
          unit=""
          plain="The payout less the affiliate share."
          edge="last"
          delay={120}
        />
      ) : null}
    </section>
  );
}

/**
 * One cell of the figures strip.
 *
 * The rule between cells is on the cell rather than the container so it can
 * change direction: stacked on a phone the divider has to run underneath, and a
 * container-level rule cannot know that. `last` drops it, because a trailing
 * divider on the last cell doubles the panel's own border.
 */
function Kpi({
  label,
  value,
  unit,
  plain,
  edge,
  delay = 0,
}: {
  label: string;
  value: string;
  unit: string;
  plain: string;
  /**
   * Where the cell sits, which decides where its rules go. Four cells stack on
   * a phone, sit two to a row on a tablet and four across on a desktop, so the
   * rule a cell needs depends on its place in each; two cells are `half` and
   * `last`. Static strings, because the class scanner reads this file rather
   * than running it.
   */
  edge: 'first' | 'second' | 'third' | 'half' | 'last';
  delay?: number;
}) {
  const rule = {
    first: 'border-b border-edge-soft sm:border-r lg:border-b-0',
    second: 'border-b border-edge-soft lg:border-b-0 lg:border-r',
    third: 'border-b border-edge-soft sm:border-b-0 sm:border-r',
    half: 'border-b border-edge-soft sm:border-b-0 sm:border-r',
    last: '',
  }[edge];
  return (
    <div
      className={`px-5 py-4 ${rule}`}
      style={{ animationDelay: `${delay}ms` }}
    >
      <h3 className="label-cap text-[10px]">{label}</h3>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="tnum text-[28px] font-medium leading-none tracking-[-0.02em]">{value}</span>
        {unit ? <span className="text-[12px] text-ink-dim">{unit}</span> : null}
      </div>
      <p className="mt-1 text-[12px] text-ink-dim">{plain}</p>
    </div>
  );
}
