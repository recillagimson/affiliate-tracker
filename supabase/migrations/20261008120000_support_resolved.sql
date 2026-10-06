-- ---------------------------------------------------------------------------
-- Support tickets gain a third status: resolved.
--
-- Closed says a conversation is over; it does not say why. An admin marking a
-- ticket resolved is saying the thing that was asked about has been dealt
-- with, which is the answer an affiliate is waiting for and the one worth
-- being able to filter on. So there are three now:
--
--   open      still being worked on
--   resolved  an admin has dealt with it
--   closed    ended without that, usually by the affiliate
--
-- closed_at and closed_by keep their names and are used for both ways of
-- ending: they record when a ticket stopped being open, and who ended it.
-- The pair check is widened to match. A reply still reopens either, which
-- add_support_message already does by setting status to open.
--
-- The list is the same list as SUPPORT_STATUSES in lib/support.ts.
-- scripts/support-store-checks.ts reads this file and fails if they disagree.
--
-- Safe to run twice.
-- ---------------------------------------------------------------------------

alter table public.support_tickets drop constraint if exists support_tickets_status_check;
alter table public.support_tickets
  add constraint support_tickets_status_check
    check (status in ('open', 'resolved', 'closed'));

alter table public.support_tickets drop constraint if exists support_tickets_closed_pair_check;
alter table public.support_tickets
  add constraint support_tickets_closed_pair_check
    check ((status <> 'open') = (closed_at is not null));

comment on column public.support_tickets.closed_at is
  'When the ticket stopped being open, whether it was resolved or closed.';
