alter table public.referral_intake
  add column withdrawn_items text[] not null default '{}'::text[],
  add column revoked_at timestamptz,
  add column qr_token text,
  add constraint referral_withdrawn_item_ids
    check (withdrawn_items <@ array['result', 'history', 'note', 'previous-result']::text[]);

update public.referral_intake set withdrawn_items = array['note']
where note_withdrawn_at is not null;

alter table public.referral_events
  add column actor_user uuid references auth.users(id) on delete set null,
  drop constraint referral_events_kind_check,
  add constraint referral_events_kind_check check (kind in (
    'view', 'export', 'request', 'approve', 'decline', 'withdraw', 'revoke',
    'appointment_proposed', 'appointment_confirmed', 'appointment_reschedule_requested'
  ));
create index referral_events_actor on public.referral_events (actor_user) where actor_user is not null;

create function public.accept_referral_status(referral_id text, staff_user uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  referral public.referral_intake;
  checked_at timestamptz;
begin
  select r.* into referral
  from public.referral_intake as r
  join public.referral_accounts as a on a.user_id = staff_user and a.clinic = r.clinic
  where r.id = referral_id
  for update of r;
  if not found then
    return jsonb_build_object('status', 404, 'message', 'The issuer could not find this referral.');
  end if;
  if referral.revoked_at is not null then
    return jsonb_build_object('status', 410, 'message', 'Online access to this referral was revoked.');
  end if;
  checked_at := clock_timestamp();
  if referral.accepted_at is null then
    if referral.expires_at <= checked_at then
      return jsonb_build_object('status', 410, 'message', 'This referral has expired.');
    end if;
    update public.referral_intake as r
    set accepted_at = checked_at, accepted_by = staff_user
    where r.id = referral.id returning r.* into referral;
  end if;
  return jsonb_build_object('id', referral.id, 'accepted_at', referral.accepted_at);
end;
$$;
revoke execute on function public.accept_referral_status(text, uuid) from public, anon, authenticated;
grant execute on function public.accept_referral_status(text, uuid) to service_role;

create or replace function public.accept_referral(referral_id text, staff_user uuid)
returns table (id text, accepted_at timestamptz)
language sql
security invoker
set search_path = ''
as $$
  select receipt ->> 'id', (receipt ->> 'accepted_at')::timestamptz
  from public.accept_referral_status(referral_id, staff_user) as receipt
  where receipt ? 'id';
$$;

create or replace function public.referral_details(referral_id text, staff_user uuid, signed_pass boolean, access_purpose text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  referral public.referral_intake;
  visible_items jsonb;
  accessed_at timestamptz;
  appointment_export jsonb;
  clean_note constant text := 'Please review the hemoglobin result at the next visit.';
  source_note constant text := clean_note || ' History of depression is documented in the referring chart.';
begin
  if access_purpose is null or access_purpose not in ('view', 'prepare_export') then
    return jsonb_build_object('status', 400, 'message', 'Choose a valid access purpose.');
  end if;

  select r.* into referral
  from public.referral_intake as r
  join public.referral_accounts as a on a.user_id = staff_user and a.clinic = r.clinic
  where r.id = referral_id
  for update of r;
  if not found then
    return jsonb_build_object('status', 404, 'message', 'The issuer could not find this referral.');
  end if;

  accessed_at := clock_timestamp();
  if referral.revoked_at is not null then
    return jsonb_build_object('status', 410, 'message', 'Online access to this referral was revoked.');
  end if;
  if referral.expires_at <= accessed_at then
    return jsonb_build_object('status', 410, 'message', 'This referral has expired.');
  end if;
  -- The signed_pass argument remains for existing RPC callers. Intake still requires acceptance.
  if referral.accepted_at is null then
    return jsonb_build_object('status', 409, 'message', 'Accept this referral into intake to open its details.');
  end if;

  select coalesce(jsonb_agg(
    case when item ->> 'id' = 'note' and 'history' = any(referral.withdrawn_items)
      then jsonb_set(item, '{text}', to_jsonb(clean_note)) else item end
    order by position), '[]'::jsonb) into visible_items
  from jsonb_array_elements(referral.items) with ordinality as entries(item, position)
  where not (item ->> 'id' = any(referral.withdrawn_items))
    and (item ->> 'id' <> 'note' or not ('history' = any(referral.withdrawn_items))
      or item ->> 'text' in (clean_note, source_note));
  if referral.request_status = 'approved' and not ('previous-result' = any(referral.withdrawn_items)) then
    visible_items := visible_items || jsonb_build_array(public.referral_previous_result());
  end if;

  if access_purpose = 'prepare_export' then
    if referral.appointment ->> 'status' = 'confirmed' then
      appointment_export := jsonb_build_object('id', referral.appointment -> 'id',
        'status', referral.appointment -> 'status', 'startsAt', referral.appointment -> 'startsAt');
    end if;
    return jsonb_build_object('items', visible_items, 'issuedAt', referral.issued_at,
      'expiresAt', referral.expires_at, 'appointment', appointment_export);
  end if;
  insert into public.referral_events (referral_id, kind, recorded_at, item_ids, actor_user)
  values (referral.id, access_purpose, accessed_at, public.referral_item_ids(visible_items), staff_user);
  return jsonb_build_object('items', visible_items);
end;
$$;

create or replace function public.record_referral_export(
  referral_id text, staff_user uuid, signed_pass boolean, expected_items jsonb, signed_receipt text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_snapshot jsonb;
begin
  current_snapshot := public.referral_details(referral_id, staff_user, signed_pass, 'prepare_export');
  if current_snapshot ? 'status' then
    return current_snapshot;
  end if;
  -- The existing RPC argument now carries the complete snapshot, including appointment metadata.
  if current_snapshot is distinct from expected_items then
    return jsonb_build_object('status', 409, 'message', 'Sharing or appointment details changed during export. Download a fresh copy.');
  end if;
  if signed_receipt is null or char_length(signed_receipt) > 2048
      or signed_receipt !~ '^[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$' then
    return jsonb_build_object('status', 400, 'message', 'The export receipt is unavailable.');
  end if;
  insert into public.referral_events (referral_id, kind, recorded_at, item_ids, receipt, actor_user)
  values (referral_id, 'export', clock_timestamp(), public.referral_item_ids(current_snapshot -> 'items'), signed_receipt, staff_user);
  return jsonb_build_object('recorded', true);
end;
$$;

create or replace function public.manage_referral(referral_id text, actor_user uuid, manage_action text, request_reason text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  referral public.referral_intake;
  is_patient boolean;
  printed_ids text[];
  previous_item jsonb := public.referral_previous_result();
  original_ids text[];
  changed_at timestamptz;
  changed_ids text[];
  item_id text;
  target_status text;
  access_status text;
  recorded_events jsonb;
  disclosed_ids text[];
  review jsonb;
  clean_note constant text := 'Please review the hemoglobin result at the next visit.';
  source_note constant text := clean_note || ' History of depression is documented in the referring chart.';
begin
  select r.* into referral
  from public.referral_intake as r
  join public.referral_accounts as a on a.user_id = actor_user
    and ((a.clinic is null and r.patient_id = actor_user) or a.clinic = r.clinic)
  where r.id = referral_id
  for update of r;
  if not found then
    return jsonb_build_object('status', 404, 'message', 'The issuer could not find this referral.');
  end if;

  is_patient := referral.patient_id = actor_user;
  changed_at := clock_timestamp();
  if manage_action is null or manage_action not in ('review', 'withdraw', 'revoke', 'request', 'approve', 'decline') then
    return jsonb_build_object('status', 400, 'message', 'Choose a referral action.');
  end if;
  if (is_patient and manage_action = 'request') or
      (not is_patient and manage_action in ('withdraw', 'revoke', 'approve', 'decline')) then
    return jsonb_build_object('status', 403, 'message', 'This account cannot take that action.');
  end if;
  if not is_patient and referral.accepted_at is null then
    return jsonb_build_object('status', 409, 'message', 'Accept this referral into intake first.');
  end if;
  if manage_action not in ('review', 'revoke') then
    if referral.revoked_at is not null then
      return jsonb_build_object('status', 410, 'message', 'Online access to this referral was revoked.');
    end if;
    if referral.expires_at <= changed_at then
      return jsonb_build_object('status', 410, 'message', 'This referral has expired.');
    end if;
  end if;

  original_ids := public.referral_item_ids(referral.items);
  -- Older referrals did not record their paper contents. Treat all original items as printed.
  printed_ids := coalesce(referral.paper_ids, original_ids);
  if manage_action = 'withdraw' then
    item_id := coalesce(request_reason, 'note');
    if item_id not in ('result', 'history', 'note', 'previous-result') then
      return jsonb_build_object('status', 400, 'message', 'Choose an item to withdraw.');
    end if;
    if item_id = any(printed_ids) or
        (not (item_id = any(original_ids)) and
         not (item_id = 'previous-result' and referral.request_status is not distinct from 'approved')) then
      return jsonb_build_object('status', 409, 'message', 'This referral does not share that item online only.');
    end if;
    if not (item_id = any(referral.withdrawn_items)) then
      changed_ids := array[item_id];
      -- An older narrative without a known clean version cannot be sanitized safely.
      if item_id = 'history' and not ('note' = any(referral.withdrawn_items)) and exists (
        select 1 from jsonb_array_elements(referral.items) as entry(item)
        where item ->> 'id' = 'note' and (item ->> 'text' is null or item ->> 'text' not in (clean_note, source_note))
      ) then
        changed_ids := array_append(changed_ids, 'note');
      end if;
      update public.referral_intake as r
      set withdrawn_items = r.withdrawn_items || changed_ids
      where r.id = referral.id returning r.* into referral;
    end if;
  elsif manage_action = 'revoke' and referral.revoked_at is null then
    if referral.expires_at <= changed_at then
      return jsonb_build_object('status', 410, 'message', 'This referral has expired.');
    end if;
    update public.referral_intake as r set revoked_at = changed_at
    where r.id = referral.id returning r.* into referral;
    changed_ids := '{}'::text[];
  elsif manage_action = 'request' then
    if request_reason is null or char_length(btrim(request_reason)) not between 1 and 240 then
      return jsonb_build_object('status', 400, 'message', 'Enter a reason of up to 240 characters.');
    end if;
    if referral.request_status is null then
      update public.referral_intake as r
      set request_status = 'pending', request_reason = btrim(manage_referral.request_reason)
      where r.id = referral.id returning r.* into referral;
      changed_ids := array[previous_item ->> 'id'];
    elsif referral.request_reason <> btrim(request_reason) then
      return jsonb_build_object('status', 409, 'message', 'A previous result has already been requested.');
    end if;
  elsif manage_action in ('approve', 'decline') then
    target_status := case when manage_action = 'approve' then 'approved' else 'declined' end;
    if referral.request_status = 'pending' then
      update public.referral_intake as r set request_status = target_status where r.id = referral.id
      returning r.* into referral;
      changed_ids := array[previous_item ->> 'id'];
    elsif referral.request_status is distinct from target_status then
      return jsonb_build_object('status', 409, 'message', 'There is no pending request to answer.');
    end if;
  end if;

  if changed_ids is not null then
    insert into public.referral_events (referral_id, kind, recorded_at, item_ids, actor_user)
    values (referral.id, manage_action, changed_at, changed_ids, manage_referral.actor_user);
  end if;

  select jsonb_agg(jsonb_build_object('kind', e.kind, 'at', e.recorded_at, 'itemIds', e.item_ids)
                   || case when e.receipt is null then '{}'::jsonb else jsonb_build_object('receipt', e.receipt) end
                   order by e.recorded_at, e.id)
  into recorded_events
  from (
    select -2 as id, 'issued' as kind, referral.issued_at as recorded_at, printed_ids as item_ids, null::text as receipt
    union all
    select -1, 'intake', referral.accepted_at, printed_ids, null::text where referral.accepted_at is not null
    union all
    select event.id, event.kind, event.recorded_at, event.item_ids, event.receipt
    from public.referral_events as event where event.referral_id = referral.id
  ) as e;

  select array(
    select distinct disclosed.item_id
    from public.referral_events as e cross join unnest(e.item_ids) as disclosed(item_id)
    where e.referral_id = referral.id and e.kind in ('view', 'export')
    order by disclosed.item_id
  ) into disclosed_ids;

  access_status := case when referral.revoked_at is not null then 'revoked'
    when referral.expires_at <= changed_at then 'expired' else 'active' end;
  review := jsonb_build_object(
    'printMode', coalesce(referral.print_mode, 'unknown'), 'paperIds', printed_ids,
    'withdrawn', 'note' = any(referral.withdrawn_items), 'withdrawnIds', referral.withdrawn_items,
    'noteRedacted', 'history' = any(referral.withdrawn_items) and not ('note' = any(referral.withdrawn_items))
      and exists (select 1 from jsonb_array_elements(referral.items) as entry(item)
        where item ->> 'id' = 'note' and item ->> 'text' = source_note),
    'revokedAt', referral.revoked_at, 'accessStatus', access_status, 'sharedIds', disclosed_ids,
    'request', case when referral.request_status is not null and (is_patient or access_status = 'active')
      then jsonb_build_object('reason', referral.request_reason, 'status', referral.request_status) end,
    'events', recorded_events
  );
  if is_patient then
    review := review || jsonb_build_object('items', referral.items || jsonb_build_array(previous_item));
  end if;
  return jsonb_build_object('review', review);
end;
$$;

create or replace function public.referral_appointment(
  referral_id text, actor_user uuid, decision text, expected_proposal text,
  proposed_start timestamptz, preparation text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  referral public.referral_intake;
  slot jsonb;
  patient_action boolean;
  target_status text;
begin
  select r.* into referral
  from public.referral_intake as r
  join public.referral_accounts as a on a.user_id = actor_user
    and (a.clinic = r.clinic or (a.clinic is null and r.patient_id = actor_user))
  where r.id = referral_id
  for update of r;
  if not found then
    return jsonb_build_object('status', 404, 'message', 'The issuer could not find this referral.');
  end if;
  if decision is null or decision not in ('propose', 'confirm', 'reschedule') then
    return jsonb_build_object('status', 400, 'message', 'Choose an appointment action.');
  end if;
  patient_action := referral.patient_id = actor_user;
  if patient_action = (decision = 'propose') then
    return jsonb_build_object('status', 403, 'message', 'This account cannot take that appointment action.');
  end if;
  if referral.revoked_at is not null then
    return jsonb_build_object('status', 410, 'message', 'Online access to this referral was revoked.');
  end if;
  if referral.accepted_at is null then
    return jsonb_build_object('status', 409, 'message', 'Accept this referral for intake before proposing an appointment.');
  end if;
  slot := referral.appointment;
  if slot ->> 'id' is distinct from expected_proposal then
    return jsonb_build_object('status', 409, 'message', 'The appointment changed. Review the current time before responding.');
  end if;

  if decision = 'propose' then
    if slot ->> 'status' = 'confirmed' then
      return jsonb_build_object('status', 409, 'message', 'This appointment is already confirmed.');
    end if;
    if proposed_start is null or not isfinite(proposed_start) or proposed_start <= clock_timestamp() then
      return jsonb_build_object('status', 400, 'message', 'Choose a future appointment time.');
    end if;
    if preparation is null or char_length(btrim(preparation)) > 400 then
      return jsonb_build_object('status', 400, 'message', 'Keep the appointment instructions to 400 characters or less.');
    end if;
    target_status := 'proposed';
    slot := jsonb_build_object('id', gen_random_uuid(), 'status', target_status, 'startsAt', proposed_start,
      'instructions', btrim(preparation));
  else
    target_status := case when decision = 'confirm' then 'confirmed' else 'reschedule_requested' end;
    if slot ->> 'status' = target_status then
      return jsonb_build_object('appointment', slot);
    end if;
    if slot ->> 'status' is distinct from 'proposed' then
      return jsonb_build_object('status', 409, 'message', 'There is no appointment proposal to answer.');
    end if;
    if decision = 'confirm' and (slot ->> 'startsAt')::timestamptz <= clock_timestamp() then
      return jsonb_build_object('status', 409, 'message', 'That time has passed. Ask the clinic for another time.');
    end if;
    slot := jsonb_set(slot, '{status}', to_jsonb(target_status));
  end if;

  update public.referral_intake as r set appointment = slot where r.id = referral.id;
  insert into public.referral_events (referral_id, kind, recorded_at, item_ids, actor_user)
  values (referral.id, 'appointment_' || target_status, clock_timestamp(), '{}'::text[], referral_appointment.actor_user);
  return jsonb_build_object('appointment', slot);
end;
$$;
