-- ---------------------------------------------------------------------------
-- The tradelines reference number: a code like TL-48213 for every affiliate
-- onboarded for tradelines, and nobody else's.
--
-- It is what the tradelines checkout will carry, so that a sale is recorded
-- against a person: who sold it, for how much, and so who is owed. Nothing
-- reads it for that yet. This puts the code on file first, so that when the
-- checkout is built everybody already has theirs.
--
-- The database hands them out, with the trigger below, rather than the app.
-- An account is given a code the moment tradelines is among its services and
-- it has none: a new account created on tradelines, or an existing one that
-- has tradelines added. No route has to remember to.
--
-- Once given, a code stays. Unticking tradelines does not remove it, ticking
-- it again brings the same one back, and it is never handed to somebody else:
-- a sale already made has to keep pointing at the person who made it. The
-- trigger refuses a change to one, so the only way to alter a code is to drop
-- the trigger on purpose.
--
-- The shape is TL- and five digits, the same pattern as TRADELINE_REF_PATTERN
-- in lib/tradeline-ref.ts. scripts/tradeline-ref-checks.ts reads this file and
-- fails if they disagree. Drawn at random, so that one person's code says
-- nothing about anybody else's or about how many there are.
--
-- Run this before the code that comes with it is deployed. Without it every
-- page still works and simply shows no code for anybody.
--
-- Safe to run twice.
-- ---------------------------------------------------------------------------

alter table public.users
  add column if not exists tradeline_ref text;

alter table public.users drop constraint if exists users_tradeline_ref_check;
alter table public.users
  add constraint users_tradeline_ref_check
    check (tradeline_ref is null or tradeline_ref ~ '^TL-[0-9]{5}$');

comment on column public.users.tradeline_ref is
  'The code that says who sold a tradeline, like TL-48213. Given by trigger when tradelines is first among their services, and never changed after. Null for somebody never on tradelines.';

create unique index if not exists users_tradeline_ref_key
  on public.users (tradeline_ref);

create or replace function public.assign_tradeline_ref()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  candidate text;
begin
  -- A code already given is kept, whatever the update says.
  if tg_op = 'UPDATE' and old.tradeline_ref is not null then
    new.tradeline_ref := old.tradeline_ref;
    return new;
  end if;

  if 'tradelines' = any (new.services) and new.tradeline_ref is null then
    -- Draw until one is free. With ninety thousand codes that is nearly always
    -- the first. Two accounts saved in the same instant could still draw the
    -- same one; the unique index then refuses the second, and saving it again
    -- draws another.
    loop
      candidate := 'TL-' || (10000 + floor(random() * 90000))::int::text;
      exit when not exists (select 1 from public.users where tradeline_ref = candidate);
    end loop;
    new.tradeline_ref := candidate;
  end if;

  return new;
end;
$$;

revoke all on function public.assign_tradeline_ref() from public, anon, authenticated;

drop trigger if exists users_tradeline_ref_trigger on public.users;
create trigger users_tradeline_ref_trigger
  before insert or update
  on public.users
  for each row
  execute function public.assign_tradeline_ref();

-- Everybody already on tradelines. The update changes nothing itself; it is
-- there to run the trigger, which gives each of them a code.
update public.users
  set services = services
  where 'tradelines' = any (services)
    and tradeline_ref is null;
