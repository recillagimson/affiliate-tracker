-- ---------------------------------------------------------------------------
-- Approval texts: an affiliate is texted, through GoHighLevel, when their
-- approvals land. See lib/sms.ts.
--
-- sms_opt_in_at is the consent record: null until the affiliate ticks the box
-- on their details, and the moment they first ticked it after. Unticking sets
-- it back to null. Nobody is texted without it.
--
-- ghl_contact_id is the GHL contact an affiliate's texts go to, remembered
-- after the first one so later texts skip the lookup. Empty until then, and
-- emptied again if GHL ever refuses it.
--
-- sms_log is every text sent, skipped or failed, with why. user_id is set null
-- rather than cascaded when an account is removed: the log is a record that a
-- message went to a phone, and that stays true.
--
-- Run this before the code that comes with it is deployed. Without it the app
-- carries on as before — the account reads elsewhere do not name these columns
-- — but saving step 1 with the box ticked is refused, and no texts go out.
--
-- Same access model as every other table: RLS on, no policies, nothing for
-- anon or authenticated. Only the service role, on the server, reads it.
--
-- Safe to run twice.
-- ---------------------------------------------------------------------------

alter table public.users
  add column if not exists sms_opt_in_at timestamptz,
  add column if not exists ghl_contact_id text not null default '';

comment on column public.users.sms_opt_in_at is
  'When the affiliate agreed to approval texts. Null means they have not, and are not texted.';
comment on column public.users.ghl_contact_id is
  'The GoHighLevel contact this affiliate''s texts go to. Empty until the first text.';

create table if not exists public.sms_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id text references public.users (id) on delete set null,
  usr text not null default '',
  phone text not null default '',
  status text not null check (status in ('sent', 'skipped', 'failed')),
  approvals integer not null default 0,
  message text not null default '',
  detail text not null default '',
  ghl_message_id text not null default ''
);

create index if not exists sms_log_user_created_idx on public.sms_log (user_id, created_at desc);

alter table public.sms_log enable row level security;
revoke all on public.sms_log from anon, authenticated;
