-- ---------------------------------------------------------------------------
-- Support attachments move out of the table and into Supabase Storage, so a
-- ticket can carry a screen recording or a PDF as well as a screenshot.
--
-- 20261006120000 kept each image as base64 in public.support_attachments.data,
-- the way a payout receipt is kept. That is right for one small scan and wrong
-- for a video: the bytes had to travel through the app inside a JSON body,
-- which the host caps at a few megabytes. Now the browser uploads each file
-- straight to a private bucket, and the table keeps only where it went.
--
-- Three changes:
--
--   - A private bucket, support-attachments, limited to 50 MB a file and to
--     the same seven types as SUPPORT_FILE_TYPES in lib/support.ts. No
--     policies are added on storage.objects, so only the service role can
--     read or write it; the app hands out short-lived signed URLs after it
--     has checked who is asking.
--   - public.support_attachments loses `data` and gains `path`.
--   - The two functions that write attachments take a path instead of the
--     bytes, and count to 5 instead of 3.
--
-- The type list, 5, and 52428800 are the same values as in lib/support.ts.
-- scripts/support-store-checks.ts reads this file and fails if they disagree.
--
-- Safe to run twice.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'support-attachments',
  'support-attachments',
  false,
  52428800,
  array['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm', 'application/pdf']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- The table. Any image already stored the old way would be lost by dropping
-- its column, so this refuses rather than deciding that for anybody. On a
-- project that has only just had 20261006120000 there are none.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'support_attachments' and column_name = 'data'
  ) then
    if exists (select 1 from public.support_attachments where data is not null limit 1) then
      raise exception
        'public.support_attachments still holds images stored in the table. Refusing to drop them automatically; move them to storage or delete those rows first.';
    end if;
  end if;
end $$;

alter table public.support_attachments drop constraint if exists support_attachments_data_check;
alter table public.support_attachments drop column if exists data;

alter table public.support_attachments add column if not exists path text;
alter table public.support_attachments alter column path set not null;

-- A video is larger than an integer's worth of bytes only in theory, but the
-- column should not be the thing that finds out.
alter table public.support_attachments alter column size type bigint;

alter table public.support_attachments drop constraint if exists support_attachments_type_check;
alter table public.support_attachments
  add constraint support_attachments_type_check
    check (type in ('image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm', 'application/pdf'));

alter table public.support_attachments drop constraint if exists support_attachments_path_check;
alter table public.support_attachments
  add constraint support_attachments_path_check check (char_length(path) > 0);

comment on table public.support_attachments is
  'Files attached to a support message: where each one is in the support-attachments storage bucket. Opened through a signed-in route that hands out a short-lived link.';

comment on column public.support_attachments.path is
  'The object''s path inside the support-attachments bucket.';

-- ---------------------------------------------------------------------------
-- Opening a ticket, as before, with attachments by path.
--
-- p_attachments is a jsonb array of
--   {"name": <text>, "type": <text>, "size": <bigint>, "path": <text>}.
-- The app has already read each file's real size and type back from storage.
--
--   LG001  a subject, message, category or file list it cannot accept (422)
--   LG003  the account is not an affiliate, or does not exist         (422)
-- ---------------------------------------------------------------------------
create or replace function public.create_support_ticket(
  p_user_id text,
  p_subject text,
  p_category text,
  p_opened_by text,
  p_opened_by_role text,
  p_author_id text,
  p_body text,
  p_attachments jsonb
)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_ticket_id bigint;
  v_message_id bigint;
  v_subject text := btrim(coalesce(p_subject, ''));
  v_body text := btrim(coalesce(p_body, ''));
  v_files jsonb := coalesce(p_attachments, '[]'::jsonb);
  v_now timestamptz := now();
begin
  if char_length(v_subject) not between 1 and 150 then
    raise exception 'A ticket needs a subject of up to 150 characters.' using errcode = 'LG001';
  end if;
  if char_length(v_body) not between 1 and 5000 then
    raise exception 'A message needs some text, up to 5,000 characters.' using errcode = 'LG001';
  end if;
  if p_category is null or p_category not in ('question', 'payout', 'bug', 'feedback') then
    raise exception 'Choose what the ticket is about.' using errcode = 'LG001';
  end if;
  if p_opened_by_role is null or p_opened_by_role not in ('affiliate', 'admin') then
    raise exception 'That ticket could not be read. Reload the page and try again.' using errcode = 'LG001';
  end if;
  if jsonb_typeof(v_files) <> 'array' then
    raise exception 'Those files could not be read. Attach them again.' using errcode = 'LG001';
  end if;
  if jsonb_array_length(v_files) > 5 then
    raise exception 'Up to 5 files can be attached to a message.' using errcode = 'LG001';
  end if;

  if not exists (select 1 from public.users u where u.id = p_user_id and u.role = 'affiliate') then
    raise exception 'A ticket can only be opened for an affiliate account.' using errcode = 'LG003';
  end if;

  insert into public.support_tickets (
    user_id, subject, category, status, opened_by, opened_by_role,
    created_at, last_message_at, last_message_role, affiliate_read_at, admin_read_at
  )
  values (
    p_user_id, v_subject, p_category, 'open', coalesce(p_opened_by, ''), p_opened_by_role,
    v_now, v_now, p_opened_by_role,
    case when p_opened_by_role = 'affiliate' then v_now end,
    case when p_opened_by_role = 'admin' then v_now end
  )
  returning id into v_ticket_id;

  insert into public.support_messages (ticket_id, author_role, author_id, author_name, body, created_at)
  values (v_ticket_id, p_opened_by_role, coalesce(p_author_id, ''), coalesce(p_opened_by, ''), v_body, v_now)
  returning id into v_message_id;

  insert into public.support_attachments (message_id, ticket_id, name, type, size, path)
  select v_message_id, v_ticket_id, coalesce(x.name, 'file'), x.type, x.size, x.path
  from jsonb_to_recordset(v_files) as x(name text, type text, size bigint, path text);

  return v_ticket_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Adding a message, as before, with attachments by path.
--
--   LG001  a message or file list it cannot accept        (validation, 422)
--   LG005  no such ticket                                 (not found, 404)
-- ---------------------------------------------------------------------------
create or replace function public.add_support_message(
  p_ticket_id bigint,
  p_author_role text,
  p_author_id text,
  p_author_name text,
  p_body text,
  p_attachments jsonb
)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_found bigint;
  v_message_id bigint;
  v_body text := btrim(coalesce(p_body, ''));
  v_files jsonb := coalesce(p_attachments, '[]'::jsonb);
  v_now timestamptz := now();
begin
  if char_length(v_body) not between 1 and 5000 then
    raise exception 'A message needs some text, up to 5,000 characters.' using errcode = 'LG001';
  end if;
  if p_author_role is null or p_author_role not in ('affiliate', 'admin') then
    raise exception 'That message could not be read. Reload the page and try again.' using errcode = 'LG001';
  end if;
  if jsonb_typeof(v_files) <> 'array' then
    raise exception 'Those files could not be read. Attach them again.' using errcode = 'LG001';
  end if;
  if jsonb_array_length(v_files) > 5 then
    raise exception 'Up to 5 files can be attached to a message.' using errcode = 'LG001';
  end if;

  select t.id into v_found from public.support_tickets t where t.id = p_ticket_id for update;
  if v_found is null then
    raise exception 'That ticket no longer exists.' using errcode = 'LG005';
  end if;

  insert into public.support_messages (ticket_id, author_role, author_id, author_name, body, created_at)
  values (p_ticket_id, p_author_role, coalesce(p_author_id, ''), coalesce(p_author_name, ''), v_body, v_now)
  returning id into v_message_id;

  insert into public.support_attachments (message_id, ticket_id, name, type, size, path)
  select v_message_id, p_ticket_id, coalesce(x.name, 'file'), x.type, x.size, x.path
  from jsonb_to_recordset(v_files) as x(name text, type text, size bigint, path text);

  update public.support_tickets
    set last_message_at = v_now,
        last_message_role = p_author_role,
        affiliate_read_at = case when p_author_role = 'affiliate' then v_now else affiliate_read_at end,
        admin_read_at = case when p_author_role = 'admin' then v_now else admin_read_at end,
        status = 'open',
        closed_at = null,
        closed_by = ''
    where id = p_ticket_id;

  return v_message_id;
end;
$$;
