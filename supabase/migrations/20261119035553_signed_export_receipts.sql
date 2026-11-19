alter table public.referral_events
  add column receipt text,
  add constraint referral_export_receipt_format
    check (receipt is null or (kind = 'export' and char_length(receipt) <= 2048
      and receipt ~ '^[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$'));

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
begin
  if access_purpose is null or access_purpose not in ('view', 'export', 'prepare_export') then
    return jsonb_build_object('status', 400, 'message', 'Choose a valid access purpose.');
  end if;

  -- Read and record the disclosure under the same lock used for consent changes.
  select r.* into referral
  from public.referral_intake as r
  join public.referral_accounts as a on a.user_id = staff_user and a.clinic = r.clinic
  where r.id = referral_id
  for update of r;
  if not found then
    return jsonb_build_object('status', 404, 'message', 'The issuer could not find this referral.');
  end if;

  accessed_at := clock_timestamp();
  if referral.expires_at <= accessed_at then
    return jsonb_build_object('status', 410, 'message', 'This referral has expired.');
  end if;
  if referral.accepted_at is null and signed_pass is distinct from true then
    return jsonb_build_object('status', 409, 'message', 'Accept this referral into intake to open its details.');
  end if;

  visible_items := referral.items;
  if referral.note_withdrawn_at is not null then
    select coalesce(jsonb_agg(item order by position), '[]'::jsonb) into visible_items
    from jsonb_array_elements(referral.items) with ordinality as entries(item, position)
    where item ->> 'id' <> 'note';
  end if;
  if referral.request_status = 'approved' then
    visible_items := visible_items || jsonb_build_array(public.referral_previous_result());
  end if;

  if access_purpose = 'prepare_export' then
    return jsonb_build_object('items', visible_items, 'issuedAt', referral.issued_at);
  end if;

  insert into public.referral_events (referral_id, kind, recorded_at, item_ids)
  values (referral.id, access_purpose, accessed_at, public.referral_item_ids(visible_items));
  return jsonb_build_object('items', visible_items);
end;
$$;

create function public.record_referral_export(
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
  -- This call locks the referral until the export is recorded and rechecks the
  -- same authorization and expiry rules used to prepare the signed snapshot.
  current_snapshot := public.referral_details(referral_id, staff_user, signed_pass, 'prepare_export');
  if current_snapshot ? 'status' then
    return current_snapshot;
  end if;
  if current_snapshot -> 'items' is distinct from expected_items then
    return jsonb_build_object('status', 409, 'message', 'Sharing changed during export. Download a fresh copy.');
  end if;
  if signed_receipt is null or char_length(signed_receipt) > 2048
      or signed_receipt !~ '^[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$' then
    return jsonb_build_object('status', 400, 'message', 'The export receipt is unavailable.');
  end if;
  insert into public.referral_events (referral_id, kind, recorded_at, item_ids, receipt)
  values (referral_id, 'export', clock_timestamp(), public.referral_item_ids(expected_items), signed_receipt);
  return jsonb_build_object('recorded', true);
end;
$$;
revoke execute on function public.record_referral_export(text, uuid, boolean, jsonb, text) from public, anon, authenticated;
grant execute on function public.record_referral_export(text, uuid, boolean, jsonb, text) to service_role;

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
  changed_at timestamptz;
  changed_ids text[];
  target_status text;
  recorded_events jsonb;
  disclosed_ids text[];
  review jsonb;
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
  if manage_action is null or manage_action not in ('review', 'withdraw', 'request', 'approve', 'decline') then
    return jsonb_build_object('status', 400, 'message', 'Choose a referral action.');
  end if;
  if (is_patient and manage_action = 'request') or
      (not is_patient and manage_action in ('withdraw', 'approve', 'decline')) then
    return jsonb_build_object('status', 403, 'message', 'This account cannot take that action.');
  end if;
  if (not is_patient or manage_action <> 'review') and referral.expires_at <= changed_at then
    return jsonb_build_object('status', 410, 'message', 'This referral has expired.');
  end if;
  if not is_patient and referral.accepted_at is null then
    return jsonb_build_object('status', 409, 'message', 'Accept this referral into intake first.');
  end if;

  -- Older referrals did not record their paper contents. Treat all original items as printed.
  printed_ids := coalesce(referral.paper_ids, public.referral_item_ids(referral.items));
  if manage_action = 'withdraw' then
    if not coalesce(referral.print_mode in ('minimal', 'private'), false) or 'note' = any(printed_ids) or
        not 'note' = any(public.referral_item_ids(referral.items)) then
      return jsonb_build_object('status', 409, 'message', 'This referral has no online-only note to withdraw.');
    end if;
    if referral.note_withdrawn_at is null then
      update public.referral_intake set note_withdrawn_at = changed_at where id = referral.id
      returning * into referral;
      changed_ids := array['note'];
    end if;
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
      update public.referral_intake set request_status = target_status where id = referral.id
      returning * into referral;
      changed_ids := array[previous_item ->> 'id'];
    elsif referral.request_status is distinct from target_status then
      return jsonb_build_object('status', 409, 'message', 'There is no pending request to answer.');
    end if;
  end if;

  if changed_ids is not null then
    insert into public.referral_events (referral_id, kind, recorded_at, item_ids)
    values (referral.id, manage_action, changed_at, changed_ids);
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
    select distinct item_id
    from public.referral_events as e cross join unnest(e.item_ids) as item_id
    where e.referral_id = referral.id and e.kind in ('view', 'export')
    order by item_id
  ) into disclosed_ids;

  review := jsonb_build_object(
    'printMode', coalesce(referral.print_mode, 'unknown'), 'paperIds', printed_ids,
    'withdrawn', referral.note_withdrawn_at is not null, 'sharedIds', disclosed_ids,
    'request', case when referral.request_status is not null
      then jsonb_build_object('reason', referral.request_reason, 'status', referral.request_status) end,
    'events', recorded_events
  );
  if is_patient then
    review := review || jsonb_build_object('items', referral.items || jsonb_build_array(previous_item));
  end if;
  return jsonb_build_object('review', review);
end;
$$;
