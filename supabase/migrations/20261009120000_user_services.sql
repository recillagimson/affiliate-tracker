-- ---------------------------------------------------------------------------
-- Which services each person is onboarded for: personal cards, tradelines, or
-- both.
--
-- Until now there was one thing an affiliate could be signed up to work on,
-- so nothing recorded it. Tradelines makes it a choice, made by an admin when
-- they create the account and changeable afterwards from that person's page.
--
-- A list on the account rather than a column per service, so a third service
-- is one more value in the check below and in lib/services.ts, not another
-- column. scripts/services-checks.ts reads this file and fails if the two
-- lists disagree.
--
-- Everybody already here starts on personal cards, which is what they are all
-- doing. Nothing else in the app reads this yet: links, the rate card,
-- approvals and payouts are unchanged.
--
-- Meaningless on an admin, who keeps the default and is never shown it.
--
-- Run this before the code that comes with it is deployed. Without it every
-- page still works and everybody reads as personal cards, but saving a change
-- to somebody's services is refused with a line saying to run it.
--
-- Safe to run twice.
-- ---------------------------------------------------------------------------

alter table public.users
  add column if not exists services text[] not null default array['personal_cards']::text[];

alter table public.users drop constraint if exists users_services_check;
alter table public.users
  add constraint users_services_check
    check (
      services <@ array['personal_cards', 'tradelines']::text[]
      and cardinality(services) >= 1
    );

comment on column public.users.services is
  'What this person is onboarded for: personal_cards, tradelines, or both. Set by an admin. Meaningless on an admin.';
