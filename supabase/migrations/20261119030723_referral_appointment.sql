alter table public.referral_intake add column appointment jsonb;

create function public.referral_appointment(
  referral_id text, actor_user uuid, decision text, expected_proposal text,
  proposed_start timestamptz, preparation text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  slot jsonb;
  intake_at timestamptz;
  patient_action boolean;
  target_status text;
begin
  select r.appointment, r.accepted_at, a.clinic is null
  into slot, intake_at, patient_action
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
  if patient_action = (decision = 'propose') then
    return jsonb_build_object('status', 403, 'message', 'This account cannot take that appointment action.');
  end if;
  if intake_at is null then
    return jsonb_build_object('status', 409, 'message', 'Accept this referral for intake before proposing an appointment.');
  end if;
  -- Compare the proposal under the same row lock used to change it.
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
    slot := jsonb_build_object('id', gen_random_uuid(), 'status', 'proposed', 'startsAt', proposed_start,
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

  update public.referral_intake set appointment = slot where id = referral_id;
  return jsonb_build_object('appointment', slot);
end;
$$;

revoke execute on function public.referral_appointment(text, uuid, text, text, timestamptz, text)
from public, anon, authenticated;
grant execute on function public.referral_appointment(text, uuid, text, text, timestamptz, text) to service_role;
