alter table public.referral_intake
  drop constraint referral_intake_print_mode_check,
  add constraint referral_intake_print_mode_check check (print_mode in ('full', 'minimal', 'private')),
  add constraint referral_private_paper_empty check (print_mode is distinct from 'private' or cardinality(paper_ids) = 0);

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
                   order by e.recorded_at, e.id)
  into recorded_events
  from (
    select -2 as id, 'issued' as kind, referral.issued_at as recorded_at, printed_ids as item_ids
    union all
    select -1, 'intake', referral.accepted_at, printed_ids where referral.accepted_at is not null
    union all
    select event.id, event.kind, event.recorded_at, event.item_ids
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
