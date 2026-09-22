'use client';

import { RevealSecret } from './onboarding/RevealSecret';
import { maskAccount } from '@/lib/mask';
import { payeeBankLines, payeeContactLines, type Payee } from '@/lib/payout-admin';

/**
 * Who is being paid and where the money goes, for the moment before it is sent.
 *
 * Two panels rather than one list, because they answer two questions and an
 * admin checks them against two different things: the person against who asked,
 * the account against the transfer they are about to make.
 *
 * The account number is masked, with the same Reveal control the person's own
 * page uses — so seeing a whole account number is one deliberate press with one
 * request behind it, wherever in the app it happens, rather than something a
 * screen hands over for being open.
 *
 * A request filed under an account the roster does not list has no panel at
 * all, only a line saying so. Better than a frame of dashes over a payment
 * about to be made.
 */
export function PayeeDetails({ payee }: { payee: Payee | null }) {
  if (!payee) {
    return (
      <p className="panel-sunk mt-5 p-4 text-[13px] text-ink-soft">
        This request is filed under an account that is not on the affiliate roster, so there are no
        details to show. Check the account before sending anything.
      </p>
    );
  }

  const contact = payeeContactLines(payee);
  // The account number is the one line Reveal draws, so it is not also listed
  // above it: the same number twice, one of them stale, is how a transfer goes
  // to the wrong account.
  const revealable = Boolean(payee.bank?.last4);
  const bank = payeeBankLines(payee).filter(
    (line) => !(revealable && line.label === 'Account number'),
  );

  return (
    <div className="mt-5 grid gap-4 sm:grid-cols-2">
      <section className="panel-sunk p-4">
        <h3 className="label-cap">Who is being paid</h3>
        <p className="mt-2 text-[15px] font-semibold">{payee.name}</p>
        <dl className="mt-3 grid gap-1.5">
          {contact.map((line) => (
            <div key={line.label} className="flex flex-wrap items-baseline gap-x-3">
              <dt className="text-[12px] text-ink-dim">{line.label}</dt>
              <dd className="min-w-0 break-words text-[13px]">{line.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="panel-sunk p-4">
        <h3 className="label-cap">Where it goes</h3>
        <dl className="mt-3 grid gap-1.5">
          {bank.map((line) => (
            <div key={line.label} className="flex flex-wrap items-baseline gap-x-3">
              <dt className="text-[12px] text-ink-dim">{line.label}</dt>
              <dd className="min-w-0 break-words text-[13px]">{line.value}</dd>
            </div>
          ))}
        </dl>
        {revealable ? (
          <div className="mt-3">
            <RevealSecret
              userId={payee.userId}
              what="account"
              masked={maskAccount(payee.bank!.last4)}
              label="Account number"
            />
          </div>
        ) : null}
      </section>
    </div>
  );
}
