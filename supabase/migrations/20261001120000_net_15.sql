-- ---------------------------------------------------------------------------
-- Payment terms move from Net 45 to Net 15 (agreement version 2026-10-01).
--
-- create_payout_request re-checks eligibility itself, with the day count as a
-- literal, because a SQL function cannot read PAYOUT_DAYS from lib/payout.ts.
-- This replaces the function from 20260914120000_payout_requests.sql with the
-- same body and a cutoff of 15. scripts/payout-request-checks.ts reads the
-- newest migration that defines the function and holds its literal to
-- PAYOUT_DAYS.
--
-- The same 15 for every card, whenever it was approved and whichever version
-- of the agreement its affiliate signed, as the 45 was before it. A card
-- approved 15 or more days ago is requestable as soon as this runs.
--
-- Errors are unchanged, apart from the wording of LG003:
--   LG003  not theirs, or not 15 days old yet             (validation, 422)
--
-- Safe to run twice.
-- ---------------------------------------------------------------------------
create or replace function public.create_payout_request(
  p_user_id text,
  p_usr text,
  p_requested_by text,
  p_items jsonb
)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_request_id bigint;
  v_submitted int;
  v_distinct int;
  v_malformed int;
  v_owned int;
  v_committed int;
  v_total numeric(12, 2);
  -- UTC, to match dayOf() everywhere else in this app: a day key is never
  -- re-timezoned. Approved on D is requestable on D + 15 and every day after,
  -- which is approved_on <= today - 15.
  v_cutoff date := (now() at time zone 'utc')::date - 15;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Choose at least one approved card.' using errcode = 'LG001';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_items) as e(value)
    where jsonb_typeof(e.value) <> 'object'
  ) then
    raise exception 'Those cards could not be read. Reload the page and choose them again.'
      using errcode = 'LG001';
  end if;

  select
    count(*),
    count(distinct x.conversion_id),
    count(*) filter (where x.conversion_id is null or x.amount is null or x.amount < 0)
    into v_submitted, v_distinct, v_malformed
  from jsonb_to_recordset(p_items) as x(conversion_id bigint, amount numeric);

  -- Before the duplicate check, because a missing id is not counted by
  -- count(distinct) and would otherwise read as "selected twice".
  if v_malformed > 0 then
    raise exception 'Those cards could not be read. Reload the page and choose them again.'
      using errcode = 'LG001';
  end if;

  if v_submitted <> v_distinct then
    raise exception 'The same card was selected twice.' using errcode = 'LG002';
  end if;

  -- Hold the chosen approvals still until this commits. A delete that starts
  -- now waits for this transaction, and then its trigger sees the committed
  -- items and refuses with LG007, rather than slipping between these checks
  -- and the insert below.
  perform 1
  from public.conversions c
  join jsonb_to_recordset(p_items) as x(conversion_id bigint, amount numeric)
    on c.id = x.conversion_id
  for key share of c;

  -- Ownership and eligibility, read fresh from the tables that actually know
  -- them. A house approval (usr = '') can never pass: it belongs to no
  -- account. And the account named by p_user_id must be the one bound to
  -- p_usr, so a caller that mixed up two people cannot file one person's
  -- cards under the other's name.
  select count(*) into v_owned
  from jsonb_to_recordset(p_items) as x(conversion_id bigint, amount numeric)
  join public.conversions c on c.id = x.conversion_id
  join public.users u on u.id = p_user_id and u.usr = c.usr
  where c.usr = p_usr and c.usr <> '' and c.approved_on <= v_cutoff;

  if v_owned <> v_submitted then
    raise exception 'One of those approvals is not yours, or is not 15 days old yet.'
      using errcode = 'LG003';
  end if;

  select count(*) into v_committed
  from jsonb_to_recordset(p_items) as x(conversion_id bigint, amount numeric)
  join public.payout_request_items pri
    on pri.conversion_id = x.conversion_id and pri.released_at is null;

  if v_committed > 0 then
    raise exception 'One of those approvals is already on a request.' using errcode = 'LG004';
  end if;

  -- Each amount is rounded to the cent once, here, and the total is the sum
  -- of those rounded amounts. Letting the columns round the items and the
  -- total separately could leave a request a cent off its own lines.
  select coalesce(sum(round(x.amount, 2)), 0)::numeric(12, 2) into v_total
  from jsonb_to_recordset(p_items) as x(conversion_id bigint, amount numeric);

  insert into public.payout_requests (user_id, status, requested_at, requested_by, total_amount)
  values (p_user_id, 'requested', now(), coalesce(p_requested_by, ''), v_total)
  returning id into v_request_id;

  insert into public.payout_request_items (request_id, conversion_id, amount)
  select v_request_id, x.conversion_id, round(x.amount, 2)
  from jsonb_to_recordset(p_items) as x(conversion_id bigint, amount numeric);

  return v_request_id;
exception
  -- The race the pre-check above cannot see: two submits that both passed it
  -- before either committed. Whichever reaches the unique index second lands
  -- here instead, and everything this call wrote is rolled back with it.
  when unique_violation then
    raise exception 'One of those approvals is already on a request.' using errcode = 'LG004';
end;
$$;

comment on function public.create_payout_request(text, text, text, jsonb) is
  'Atomically create a payout request and lock its items. Called by the service role only.';

revoke all on function public.create_payout_request(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.create_payout_request(text, text, text, jsonb) to service_role;
