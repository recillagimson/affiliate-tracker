-- ---------------------------------------------------------------------------
-- Monthly payouts: payroll pays an affiliate's unpaid approvals in one go.
--
-- Affiliates no longer ask to be paid. Once a month an admin picks, per
-- affiliate, which unpaid approvals the transfer covers, and records it with
-- the date, a reference and the receipt. This function writes that as one
-- payout request that is already paid, so the cards it covers are committed
-- (and cannot be paid twice) in the same transaction as the payment itself.
--
-- Same checks as create_payout_request, minus the 15-day cutoff: payroll may
-- pay any approved card. Same error codes:
--   LG001  nothing chosen, or an item it cannot read      (validation, 422)
--   LG002  the same card twice                            (validation, 422)
--   LG003  not this affiliate's card                      (validation, 422)
--   LG004  already on a live request                      (conflict, 409)
--
-- Called by the service role only. Safe to run twice.
-- ---------------------------------------------------------------------------
create or replace function public.create_monthly_payout(
  p_user_id text,
  p_usr text,
  p_paid_by text,
  p_items jsonb,
  p_amount numeric,
  p_paid_on date,
  p_reference text,
  p_note text,
  p_proof_name text,
  p_proof_type text,
  p_proof_data text
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
  v_has_proof boolean := coalesce(p_proof_data, '') <> '';
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

  if v_malformed > 0 then
    raise exception 'Those cards could not be read. Reload the page and choose them again.'
      using errcode = 'LG001';
  end if;

  if v_submitted <> v_distinct then
    raise exception 'The same card was selected twice.' using errcode = 'LG002';
  end if;

  -- Hold the chosen approvals still until this commits, as create_payout_request does.
  perform 1
  from public.conversions c
  join jsonb_to_recordset(p_items) as x(conversion_id bigint, amount numeric)
    on c.id = x.conversion_id
  for key share of c;

  -- Every card is this affiliate's, and the account is the one bound to the key.
  -- No age check: payroll may pay any approved card.
  select count(*) into v_owned
  from jsonb_to_recordset(p_items) as x(conversion_id bigint, amount numeric)
  join public.conversions c on c.id = x.conversion_id
  join public.users u on u.id = p_user_id and u.usr = c.usr
  where c.usr = p_usr and c.usr <> '';

  if v_owned <> v_submitted then
    raise exception 'One of those approvals is not this affiliate''s.' using errcode = 'LG003';
  end if;

  select count(*) into v_committed
  from jsonb_to_recordset(p_items) as x(conversion_id bigint, amount numeric)
  join public.payout_request_items pri
    on pri.conversion_id = x.conversion_id and pri.released_at is null;

  if v_committed > 0 then
    raise exception 'One of those approvals has already been paid or requested.' using errcode = 'LG004';
  end if;

  select coalesce(sum(round(x.amount, 2)), 0)::numeric(12, 2) into v_total
  from jsonb_to_recordset(p_items) as x(conversion_id bigint, amount numeric);

  insert into public.payout_requests (
    user_id, status, requested_at, requested_by, total_amount,
    amount, paid_at, paid_by, reference, note,
    proof_name, proof_type, proof_data, proof_at, proof_by
  )
  values (
    p_user_id, 'paid', now(), coalesce(p_paid_by, '') || ' (monthly payout)', v_total,
    round(coalesce(p_amount, v_total), 2),
    -- Midday on the day the money left, as recordPayment writes it.
    (p_paid_on::text || 'T12:00:00Z')::timestamptz,
    coalesce(p_paid_by, ''),
    left(coalesce(p_reference, ''), 120),
    left(coalesce(p_note, ''), 500),
    case when v_has_proof then left(coalesce(p_proof_name, ''), 200) else '' end,
    case when v_has_proof then left(coalesce(p_proof_type, ''), 100) else '' end,
    case when v_has_proof then p_proof_data else '' end,
    case when v_has_proof then now() else null end,
    case when v_has_proof then coalesce(p_paid_by, '') else '' end
  )
  returning id into v_request_id;

  insert into public.payout_request_items (request_id, conversion_id, amount)
  select v_request_id, x.conversion_id, round(x.amount, 2)
  from jsonb_to_recordset(p_items) as x(conversion_id bigint, amount numeric);

  return v_request_id;
exception
  when unique_violation then
    raise exception 'One of those approvals has already been paid or requested.' using errcode = 'LG004';
end;
$$;

comment on function public.create_monthly_payout(text, text, text, jsonb, numeric, date, text, text, text, text, text) is
  'Atomically record a paid monthly payout covering the chosen approvals. Called by the service role only.';

revoke all on function public.create_monthly_payout(text, text, text, jsonb, numeric, date, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.create_monthly_payout(text, text, text, jsonb, numeric, date, text, text, text, text, text) to service_role;
