-- ===========================================================================
-- Document Photo Transcription ("Section 27") — database objects
--
-- WHY: The app code for document transcription is already on `main` (live) and
--      `staging`. Its database objects were built directly in the staging
--      database and never saved as a file. This file reconstructs them exactly
--      from staging (read 2026-09-26) so production can get them safely.
--
-- WHAT IT DOES (additive only — nothing is deleted or rewritten):
--   1. activities:        +2 empty columns (document_capture_id, comment_sequence)
--   2. work_order_photos: +2 empty columns (document_capture_id, document_page_number)
--   3. Allowed-value rules widened: activities may also be 'document_transcription',
--      photos may also be 'document'. Every existing row still satisfies them.
--   4. New table document_transcription_attempts (usage/limit metering; stores
--      no images or text). Owners of a shop can read their own shop's rows only.
--   5. 7 new functions + 6 new triggers enforcing: feature must be switched on
--      for that shop, tenant isolation, usage limits (30/user/hour, 200/shop/day,
--      5 pages per document, 2 "strong" retries per page).
--   6. enforce_activity_edits(): document transcriptions become editable by
--      their author or an owner — same rule as customer notes / work logs.
--
-- LIVE USERS: the feature stays OFF for every shop until an owner switches it on
--   (Shop Config -> Features). Nothing changes for anyone on day one.
--   Tables touched are small; each lock is held for milliseconds. lock_timeout
--   makes it give up (changing nothing) rather than make anyone wait.
--
-- SAFE TO RUN TWICE: if-not-exists / create-or-replace / drop-if-exists-then-create.
--
-- ROLLBACK: see the bottom of this file.
-- ===========================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1 + 2. New nullable columns (metadata-only; no table rewrite)
-- ---------------------------------------------------------------------------
alter table public.activities        add column if not exists document_capture_id  uuid;
alter table public.activities        add column if not exists comment_sequence     integer;
alter table public.work_order_photos add column if not exists document_capture_id  uuid;
alter table public.work_order_photos add column if not exists document_page_number integer;

-- ---------------------------------------------------------------------------
-- 3. Allowed-value rules. NOT VALID = applies to new/changed rows, does not scan
--    old rows (matches staging). All existing production rows already comply.
-- ---------------------------------------------------------------------------
alter table public.activities drop constraint if exists activities_activity_type_check;
alter table public.activities add constraint activities_activity_type_check
  check (activity_type = any (array[
    'work_log','inspection','ai_summary','mechanic_note','customer_note','status_change',
    'photo_added','quote_sent','approval_received','invoice_generated','payment_received',
    'part_ordered','part_received','job_edited','serial_number_captured',
    'document_transcription'])) not valid;

alter table public.activities drop constraint if exists activities_document_identity_iff_chk;
alter table public.activities add constraint activities_document_identity_iff_chk
  check ((activity_type = 'document_transcription') = (document_capture_id is not null)) not valid;

alter table public.activities drop constraint if exists activities_document_identity_pair_chk;
alter table public.activities add constraint activities_document_identity_pair_chk
  check (((document_capture_id is null) = (comment_sequence is null))
         and ((comment_sequence is null) or (comment_sequence >= 1))) not valid;

alter table public.work_order_photos drop constraint if exists work_order_photos_photo_type_check;
alter table public.work_order_photos add constraint work_order_photos_photo_type_check
  check (photo_type = any (array['general','serial_number','document'])) not valid;

alter table public.work_order_photos drop constraint if exists work_order_photos_document_identity_iff_chk;
alter table public.work_order_photos add constraint work_order_photos_document_identity_iff_chk
  check ((photo_type = 'document') = (document_capture_id is not null)) not valid;

alter table public.work_order_photos drop constraint if exists work_order_photos_document_identity_pair_chk;
alter table public.work_order_photos add constraint work_order_photos_document_identity_pair_chk
  check (((document_capture_id is null) = (document_page_number is null))
         and ((document_page_number is null)
              or ((document_page_number >= 1) and (document_page_number <= 5)))) not valid;

-- ---------------------------------------------------------------------------
-- Indexes on the existing tables (partial: only document rows are indexed)
-- ---------------------------------------------------------------------------
create unique index if not exists activities_document_capture_seq_uidx
  on public.activities (shop_id, document_capture_id, comment_sequence)
  where (document_capture_id is not null) and (comment_sequence is not null);
create index if not exists activities_document_transcription_idx
  on public.activities (work_order_id, created_at desc)
  where (activity_type = 'document_transcription');
create unique index if not exists work_order_photos_document_capture_page_uidx
  on public.work_order_photos (shop_id, document_capture_id, document_page_number)
  where (document_capture_id is not null) and (document_page_number is not null);
create index if not exists work_order_photos_document_idx
  on public.work_order_photos (work_order_id, photo_type)
  where (photo_type = 'document');

-- ---------------------------------------------------------------------------
-- 4. Metering table
-- ---------------------------------------------------------------------------
create table if not exists public.document_transcription_attempts (
  request_id          uuid        not null primary key,
  shop_id             uuid        not null references public.shops(id),
  work_order_id       text        not null references public.work_orders(id),
  document_capture_id uuid        not null,
  page_number         integer     not null check (page_number >= 1 and page_number <= 5),
  quality_tier        text        not null check (quality_tier = any (array['standard','strong'])),
  state               text        not null default 'processing'
                                  check (state = any (array['processing','completed','failed'])),
  error_category      text,
  input_tokens        integer,
  output_tokens       integer,
  requested_by        uuid        not null references public.profiles(id),
  created_at          timestamptz not null default now(),
  completed_at        timestamptz,
  reclaimed_at        timestamptz,
  constraint dta_error_category_chk check ((error_category is null) or (error_category = any (array[
    'provider_auth','provider_rate_limit','provider_client_error','provider_server_error',
    'network_error','unparseable_response','incomplete_response','tier_contract_violation',
    'unknown','stale_reclaimed']))),
  constraint dta_input_tokens_nonneg_chk  check ((input_tokens is null) or (input_tokens >= 0)),
  constraint dta_output_tokens_nonneg_chk check ((output_tokens is null) or (output_tokens >= 0)),
  constraint dta_state_timestamps_chk check (((state <> 'processing') or (completed_at is null))
                                             and ((reclaimed_at is null) or (state = 'failed')))
);

comment on table public.document_transcription_attempts is
  'Operational metering for Document Photo Transcription. Server-written only (service-role RPCs). Never stores document images, transcription text, model output, or secrets.';

create index if not exists dta_shop_capture_idx on public.document_transcription_attempts (shop_id, document_capture_id, page_number);
create index if not exists dta_shop_recent_idx  on public.document_transcription_attempts (shop_id, created_at desc);
create index if not exists dta_stale_idx        on public.document_transcription_attempts (created_at) where (state = 'processing');
create index if not exists dta_user_recent_idx  on public.document_transcription_attempts (requested_by, created_at desc);

alter table public.document_transcription_attempts enable row level security;

drop policy if exists "dta: owner read shop" on public.document_transcription_attempts;
create policy "dta: owner read shop" on public.document_transcription_attempts
  for select using (public.is_shop_owner() and public.row_in_current_shop(shop_id));

-- Browsers may only READ (and RLS limits that to owners of the shop). All writes
-- happen inside the server-only functions below.
revoke all on public.document_transcription_attempts from public, anon, authenticated, service_role;
grant select on public.document_transcription_attempts to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Functions
-- ---------------------------------------------------------------------------
create or replace function public.document_transcription_enabled(p_shop_id uuid)
 returns boolean
 language sql
 stable
 set search_path to 'public'
as $function$
  select coalesce(
    (select (s.settings #> '{features,document_transcription}') = to_jsonb(true)
       from public.shops s where s.id = p_shop_id),
    false);
$function$;

create or replace function public.dt_actor_shop_id(p_actor_id uuid)
 returns uuid
 language plpgsql
 stable
 set search_path to 'public'
as $function$
declare chosen uuid; resolved uuid;
begin
  if p_actor_id is null then return null; end if;

  select p.active_shop_id into chosen
    from public.profiles p where p.id = p_actor_id and p.active;
  if chosen is not null and exists (
    select 1 from public.shop_memberships m
    where m.profile_id = p_actor_id and m.shop_id = chosen and m.is_active
  ) then
    return chosen;
  end if;

  select m.shop_id into resolved
    from public.shop_memberships m
    join public.profiles p on p.id = m.profile_id
   where m.profile_id = p_actor_id and m.is_active and p.active
   order by (m.default_location_id is not null) desc, m.created_at asc
   limit 1;
  return resolved;
end $function$;

create or replace function public.dt_assert_attempt_tenancy()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
declare v_wo_shop uuid;
begin
  if new.shop_id is null then
    raise exception 'document_transcription_attempts.shop_id must be set by the reserving RPC';
  end if;
  if new.requested_by is null then
    raise exception 'document_transcription_attempts.requested_by is required';
  end if;
  if not exists (select 1 from public.profiles p where p.id = new.requested_by and p.active) then
    raise exception 'requested_by % is not an active profile', new.requested_by;
  end if;
  if not exists (
    select 1 from public.shop_memberships m
    where m.profile_id = new.requested_by and m.shop_id = new.shop_id and m.is_active
  ) then
    raise exception 'requested_by % has no active membership in shop %', new.requested_by, new.shop_id;
  end if;

  select wo.shop_id into v_wo_shop
    from public.work_orders wo where wo.id = new.work_order_id and wo.active;
  if v_wo_shop is null or v_wo_shop is distinct from new.shop_id then
    raise exception 'work order % is not an active work order of shop %', new.work_order_id, new.shop_id;
  end if;

  return new;
end $function$;

create or replace function public.dt_forbid_shop_change()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  if new.shop_id is distinct from old.shop_id then
    raise exception 'Cannot move a document transcription attempt between shops';
  end if;
  return new;
end $function$;

create or replace function public.dt_assert_feature_enabled()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_wo_shop_id  uuid;
  v_caller_shop uuid;
  v_role        text;
begin
  -- 1a. CANONICAL RESOLUTION. Never NEW.shop_id: a caller could supply an
  --     enabled shop's id while targeting a work order in a disabled shop, and
  --     the tenant stamp would then overwrite it with the real one.
  select w.shop_id
    into v_wo_shop_id
    from public.work_orders w
   where w.id = new.work_order_id
     and w.active;

  -- 1b. AUTHORIZE THE CALLER INTO THAT SHOP BEFORE READING THE FLAG. Every
  --     failure here raises the SAME code, message, details, and hint, and none
  --     evaluates document_transcription_enabled(), so an enabled foreign shop
  --     and a disabled foreign shop are indistinguishable in both the response
  --     and the work performed.
  v_role := coalesce(auth.role(), '');

  if v_role = 'service_role' then
    -- Server code has no caller shop. A2 decides on the canonical shop alone and
    -- relaxes nothing downstream: stamp_shop_id -> set_tenant_shop_id still runs
    -- afterwards and raises when current_user_shop_id() is null. That is
    -- pre-existing lineage behaviour, deliberately preserved.
    if v_wo_shop_id is null then
      raise exception 'This document cannot be saved to that work order.'
        using errcode = 'P0001', hint = 'DOCUMENT_ROW_NOT_ALLOWED';
    end if;
  else
    v_caller_shop := public.current_user_shop_id();
    if v_wo_shop_id is null
       or v_caller_shop is null
       or v_caller_shop <> v_wo_shop_id then
      raise exception 'This document cannot be saved to that work order.'
        using errcode = 'P0001', hint = 'DOCUMENT_ROW_NOT_ALLOWED';
    end if;
  end if;

  -- 1c. The caller is provably inside this shop, so the shop's OWN configuration
  --     is not a secret.
  if not public.document_transcription_enabled(v_wo_shop_id) then
    raise exception 'Document Photo Transcription is turned off for this shop.'
      using errcode = 'P0001', hint = 'DOCUMENT_TRANSCRIPTION_DISABLED';
  end if;

  return new;
end;
$function$;

create or replace function public.document_transcription_reserve(p_actor_id uuid, p_request_id uuid, p_document_capture_id uuid, p_work_order_id text, p_page_number integer, p_quality_tier text, p_stale_seconds integer)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  c_user_hour_limit    constant int := 30;
  c_shop_day_limit     constant int := 200;
  c_capture_page_limit constant int := 5;
  c_page_strong_limit  constant int := 2;
  c_min_stale_seconds  constant int := 90;

  v_shop      uuid;
  v_wo_shop   uuid;
  v_existing  record;
  v_count     int;
  v_pages     int;
begin
  -- Server-only. A browser JWT (role 'authenticated' or 'anon') never gets past
  -- this line even if execute were mis-granted.
  if coalesce(auth.role(), '') is distinct from 'service_role' then
    raise exception 'document_transcription_reserve is callable only by the server';
  end if;
  if p_actor_id is null then
    raise exception 'p_actor_id is required';
  end if;

  if p_request_id is null or p_document_capture_id is null or p_work_order_id is null
     or p_page_number is null or p_page_number < 1 or p_page_number > c_capture_page_limit
     or p_quality_tier is null or p_quality_tier not in ('standard','strong')
     or p_stale_seconds is null or p_stale_seconds < c_min_stale_seconds then
    return jsonb_build_object('decision','config_error','quality_tier',null,'shop_id',null,
                              'reservation_id',null,'limit_scope',null,'retry_after_seconds',null);
  end if;

  -- A non-null result proves the actor's profile is active AND holds an active
  -- membership in the returned shop.
  v_shop := public.dt_actor_shop_id(p_actor_id);
  if v_shop is null then
    return jsonb_build_object('decision','forbidden','quality_tier',null,'shop_id',null,
                              'reservation_id',null,'limit_scope',null,'retry_after_seconds',null);
  end if;

  -- A work order in another shop is reported identically to one that does not
  -- exist, so cross-shop existence is never observable.
  select wo.shop_id into v_wo_shop
    from public.work_orders wo where wo.id = p_work_order_id and wo.active;
  if v_wo_shop is null or v_wo_shop is distinct from v_shop then
    return jsonb_build_object('decision','forbidden','quality_tier',null,'shop_id',null,
                              'reservation_id',null,'limit_scope',null,'retry_after_seconds',null);
  end if;

  if not public.document_transcription_enabled(v_shop) then
    return jsonb_build_object('decision','feature_disabled','quality_tier',null,'shop_id',null,
                              'reservation_id',null,'limit_scope',null,'retry_after_seconds',null);
  end if;

  perform pg_advisory_xact_lock(hashtextextended('dta:shop:' || v_shop::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('dta:user:' || p_actor_id::text, 0));

  -- Reclaim abandoned attempts BEFORE counting. A reclaimed attempt is marked
  -- failed, never deleted: it was paid for and keeps counting.
  update public.document_transcription_attempts
     set state = 'failed',
         error_category = coalesce(error_category, 'stale_reclaimed'),
         reclaimed_at = now()
   where shop_id = v_shop
     and state = 'processing'
     and created_at < now() - make_interval(secs => p_stale_seconds);

  select a.state, a.shop_id into v_existing
    from public.document_transcription_attempts a where a.request_id = p_request_id;
  if found then
    if v_existing.shop_id is distinct from v_shop then
      -- Never confirm that a request id exists in another tenant.
      return jsonb_build_object('decision','forbidden','quality_tier',null,'shop_id',null,
                                'reservation_id',null,'limit_scope',null,'retry_after_seconds',null);
    end if;
    return jsonb_build_object(
      'decision', case v_existing.state
                    when 'processing' then 'duplicate_active'
                    when 'completed'  then 'duplicate_completed'
                    else                   'duplicate_failed' end,
      'quality_tier', null, 'shop_id', v_shop,
      'reservation_id', p_request_id, 'limit_scope', null, 'retry_after_seconds', null);
  end if;

  select count(*) into v_count from public.document_transcription_attempts
   where requested_by = p_actor_id and created_at > now() - interval '1 hour';
  if v_count >= c_user_hour_limit then
    return jsonb_build_object('decision','rate_limited','quality_tier',null,'shop_id',v_shop,
                              'reservation_id',null,'limit_scope','user_hour','retry_after_seconds',3600);
  end if;

  select count(*) into v_count from public.document_transcription_attempts
   where shop_id = v_shop and created_at > now() - interval '24 hours';
  if v_count >= c_shop_day_limit then
    return jsonb_build_object('decision','rate_limited','quality_tier',null,'shop_id',v_shop,
                              'reservation_id',null,'limit_scope','shop_day','retry_after_seconds',86400);
  end if;

  -- Five DISTINCT pages per capture, scoped to this shop. A repeat reading of a
  -- page already seen is not a sixth page.
  select count(distinct page_number) into v_pages
    from public.document_transcription_attempts
   where shop_id = v_shop and document_capture_id = p_document_capture_id;
  if v_pages >= c_capture_page_limit
     and not exists (select 1 from public.document_transcription_attempts
                      where shop_id = v_shop
                        and document_capture_id = p_document_capture_id
                        and page_number = p_page_number) then
    return jsonb_build_object('decision','rate_limited','quality_tier',null,'shop_id',v_shop,
                              'reservation_id',null,'limit_scope','capture_pages','retry_after_seconds',null);
  end if;

  if p_quality_tier = 'strong' then
    select count(*) into v_count from public.document_transcription_attempts
     where shop_id = v_shop
       and document_capture_id = p_document_capture_id
       and page_number = p_page_number
       and quality_tier = 'strong';
    if v_count >= c_page_strong_limit then
      return jsonb_build_object('decision','rate_limited','quality_tier',null,'shop_id',v_shop,
                                'reservation_id',null,'limit_scope','page_strong','retry_after_seconds',null);
    end if;
  end if;

  -- shop_id comes from this function's own verified resolution, never from the
  -- request; dt_assert_tenancy re-checks it at write time.
  insert into public.document_transcription_attempts
    (request_id, shop_id, work_order_id, document_capture_id, page_number, quality_tier, state, requested_by)
  values
    (p_request_id, v_shop, p_work_order_id, p_document_capture_id, p_page_number, p_quality_tier, 'processing', p_actor_id)
  on conflict (request_id) do nothing;

  if not found then
    -- Lost a race the advisory locks could not cover: they are shop-scoped, so
    -- two DIFFERENT shops submitting the same request UUID do not serialize
    -- against each other. Re-read the winning row rather than assuming it is
    -- ours, and never authorize a second call.
    select a.state, a.shop_id into v_existing
      from public.document_transcription_attempts a where a.request_id = p_request_id;
    if not found then
      -- Vanished between the conflict and the re-read (only possible if the
      -- winner rolled back). Refuse rather than guess.
      return jsonb_build_object('decision','config_error','quality_tier',null,'shop_id',v_shop,
                                'reservation_id',null,'limit_scope',null,'retry_after_seconds',null);
    end if;
    if v_existing.shop_id is distinct from v_shop then
      return jsonb_build_object('decision','forbidden','quality_tier',null,'shop_id',null,
                                'reservation_id',null,'limit_scope',null,'retry_after_seconds',null);
    end if;
    return jsonb_build_object(
      'decision', case v_existing.state
                    when 'processing' then 'duplicate_active'
                    when 'completed'  then 'duplicate_completed'
                    else                   'duplicate_failed' end,
      'quality_tier', null, 'shop_id', v_shop,
      'reservation_id', p_request_id, 'limit_scope', null, 'retry_after_seconds', null);
  end if;

  -- The authorized tier is ALWAYS the requested tier. There is deliberately no
  -- downgrade path: the Function refuses any mismatch, so a denial must be an
  -- explicit refusal decision instead.
  return jsonb_build_object('decision','authorized','quality_tier',p_quality_tier,'shop_id',v_shop,
                            'reservation_id',p_request_id,'limit_scope',null,'retry_after_seconds',null);
end;
$function$;

create or replace function public.document_transcription_finalize_attempt(p_actor_id uuid, p_request_id uuid, p_outcome text, p_error_category text, p_input_tokens integer, p_output_tokens integer)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if coalesce(auth.role(), '') is distinct from 'service_role' then
    raise exception 'document_transcription_finalize_attempt is callable only by the server';
  end if;
  if p_actor_id is null or p_request_id is null
     or p_outcome is null or p_outcome not in ('completed','failed') then
    return jsonb_build_object('ok', false);
  end if;
  -- Reject bad telemetry at the RPC rather than relying on the Function alone.
  if (p_input_tokens is not null and p_input_tokens < 0)
     or (p_output_tokens is not null and p_output_tokens < 0) then
    return jsonb_build_object('ok', false);
  end if;
  if p_error_category is not null and p_error_category not in (
       'provider_auth','provider_rate_limit','provider_client_error','provider_server_error',
       'network_error','unparseable_response','incomplete_response',
       'tier_contract_violation','unknown','stale_reclaimed') then
    return jsonb_build_object('ok', false);
  end if;

  update public.document_transcription_attempts
     set state = p_outcome,
         error_category = p_error_category,
         input_tokens = p_input_tokens,
         output_tokens = p_output_tokens,
         completed_at = now()
   where request_id = p_request_id
     and requested_by = p_actor_id
     and state = 'processing';

  -- `ok` reports only that the call was well formed. A no-op (already terminal,
  -- not this actor's row, unknown id) is deliberately indistinguishable: the
  -- Function swallows finalization failures anyway, and reporting otherwise
  -- would turn this into a request-id probe.
  return jsonb_build_object('ok', true);
end;
$function$;

-- Execute rights, matching staging: only the two server RPCs are callable, and
-- only by service_role (the Netlify function). Nothing is callable from browsers.
revoke all on function public.document_transcription_enabled(uuid) from public, anon, authenticated, service_role;
revoke all on function public.dt_actor_shop_id(uuid) from public, anon, authenticated, service_role;
revoke all on function public.dt_assert_attempt_tenancy() from public, anon, authenticated, service_role;
revoke all on function public.dt_forbid_shop_change() from public, anon, authenticated, service_role;
revoke all on function public.dt_assert_feature_enabled() from public, anon, authenticated, service_role;
revoke all on function public.document_transcription_reserve(uuid, uuid, uuid, text, integer, text, integer) from public, anon, authenticated, service_role;
revoke all on function public.document_transcription_finalize_attempt(uuid, uuid, text, text, integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.document_transcription_reserve(uuid, uuid, uuid, text, integer, text, integer) to service_role;
grant execute on function public.document_transcription_finalize_attempt(uuid, uuid, text, text, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Existing edit guard: document transcriptions editable like customer notes
-- ---------------------------------------------------------------------------
create or replace function public.enforce_activity_edits()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if public.is_shop_owner() then
    return new; -- owners may edit/restore/deactivate anything
  end if;

  if old.activity_type not in ('customer_note', 'work_log', 'document_transcription') and (
    new.body is distinct from old.body or new.meta is distinct from old.meta or new.active is distinct from old.active
  ) then
    raise exception 'Not permitted: only customer-facing notes, work-log customer updates, and document transcriptions can be edited after creation';
  end if;

  if old.activity_type in ('customer_note', 'work_log', 'document_transcription') and (new.body is distinct from old.body or new.meta is distinct from old.meta) then
    if old.author_id is distinct from auth.uid() then
      raise exception 'Not permitted: only the author or a shop owner may edit this update';
    end if;
  end if;

  return new;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
drop trigger if exists dt_assert_feature_activities_ins on public.activities;
create trigger dt_assert_feature_activities_ins before insert on public.activities
  for each row when (new.activity_type = 'document_transcription')
  execute function public.dt_assert_feature_enabled();

drop trigger if exists dt_assert_feature_activities_upd on public.activities;
create trigger dt_assert_feature_activities_upd before update on public.activities
  for each row when ((new.activity_type = 'document_transcription')
                     and (old.activity_type is distinct from 'document_transcription'))
  execute function public.dt_assert_feature_enabled();

drop trigger if exists dt_assert_feature_photos_ins on public.work_order_photos;
create trigger dt_assert_feature_photos_ins before insert on public.work_order_photos
  for each row when (new.photo_type = 'document')
  execute function public.dt_assert_feature_enabled();

drop trigger if exists dt_assert_feature_photos_upd on public.work_order_photos;
create trigger dt_assert_feature_photos_upd before update on public.work_order_photos
  for each row when ((new.photo_type = 'document')
                     and (old.photo_type is distinct from 'document'))
  execute function public.dt_assert_feature_enabled();

drop trigger if exists dt_assert_tenancy on public.document_transcription_attempts;
create trigger dt_assert_tenancy before insert on public.document_transcription_attempts
  for each row execute function public.dt_assert_attempt_tenancy();

drop trigger if exists dt_forbid_shop_change on public.document_transcription_attempts;
create trigger dt_forbid_shop_change before update on public.document_transcription_attempts
  for each row execute function public.dt_forbid_shop_change();

commit;

-- ===========================================================================
-- ROLLBACK (only if needed). The feature is OFF for every shop until an owner
-- turns it on, so the simplest "rollback" is: leave it off. To fully remove:
--
--   begin;
--   -- restore the edit rule production had before this release
--   create or replace function public.enforce_activity_edits()
--    returns trigger language plpgsql security definer set search_path to 'public'
--   as $function$
--   begin
--     if public.is_shop_owner() then
--       return new; -- owners may edit/restore/deactivate anything
--     end if;
--     if old.activity_type not in ('customer_note', 'work_log') and (
--       new.body is distinct from old.body or new.meta is distinct from old.meta or new.active is distinct from old.active
--     ) then
--       raise exception 'Not permitted: only customer-facing notes and work-log customer updates can be edited after creation';
--     end if;
--     if old.activity_type in ('customer_note', 'work_log') and (new.body is distinct from old.body or new.meta is distinct from old.meta) then
--       if old.author_id is distinct from auth.uid() then
--         raise exception 'Not permitted: only the author or a shop owner may edit this update';
--       end if;
--     end if;
--     return new;
--   end;
--   $function$;
--   drop trigger if exists dt_assert_feature_activities_ins on public.activities;
--   drop trigger if exists dt_assert_feature_activities_upd on public.activities;
--   drop trigger if exists dt_assert_feature_photos_ins     on public.work_order_photos;
--   drop trigger if exists dt_assert_feature_photos_upd     on public.work_order_photos;
--   -- Leave the new columns, table and constraints in place: they are harmless
--   -- when the feature is off, and removing them would erase any saved documents.
--   commit;
-- ===========================================================================
