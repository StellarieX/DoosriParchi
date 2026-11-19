insert into auth.users (id) values
  ('10000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000003'),
  ('10000000-0000-4000-8000-000000000004');
insert into public.referral_accounts (user_id, clinic) values
  ('10000000-0000-4000-8000-000000000001', null),
  ('10000000-0000-4000-8000-000000000002', 'north'),
  ('10000000-0000-4000-8000-000000000003', 'south'),
  ('10000000-0000-4000-8000-000000000004', null);

set role service_role;
do $$
declare
  patient constant uuid := '10000000-0000-4000-8000-000000000001';
  north constant uuid := '10000000-0000-4000-8000-000000000002';
  south constant uuid := '10000000-0000-4000-8000-000000000003';
  other_patient constant uuid := '10000000-0000-4000-8000-000000000004';
  r constant text := '20000000-0000-4000-8000-000000000001';
  unaccepted constant text := '20000000-0000-4000-8000-000000000002';
  minimal constant text := '20000000-0000-4000-8000-000000000003';
  items constant jsonb := '[
    {"id":"result","label":"Lab result","text":"Hemoglobin · 12.8 g/dL"},
    {"id":"history","label":"Medical history","text":"History of depression"},
    {"id":"note","label":"Referral note","text":"Please review the hemoglobin result at the next visit. History of depression is documented in the referring chart."}
  ]';
  signature constant text := 'receipt.signature';
  start_time timestamptz := clock_timestamp() + interval '2 days';
  before_withdrawal jsonb;
  before_confirmation jsonb;
  current_snapshot jsonb;
  offer jsonb;
  clinic_review jsonb;
  patient_review jsonb;
  receipt jsonb;
  routine text;
begin
  foreach routine in array array[
    'public.accept_referral(text,uuid)',
    'public.accept_referral_status(text,uuid)',
    'public.referral_details(text,uuid,boolean,text)',
    'public.manage_referral(text,uuid,text,text)',
    'public.record_referral_export(text,uuid,boolean,jsonb,text)',
    'public.referral_appointment(text,uuid,text,text,timestamptz,text)'
  ] loop
    assert not has_function_privilege('anon', routine, 'execute'), routine;
    assert not has_function_privilege('authenticated', routine, 'execute'), routine;
    assert has_function_privilege('service_role', routine, 'execute'), routine;
  end loop;

  insert into public.referral_intake (id, patient_id, clinic, issued_at, expires_at, print_mode, paper_ids, items, qr_token)
  values (r, patient, 'north', now(), now() + interval '1 day', 'private', '{}', items, 'payload.signature'),
    (unaccepted, patient, 'north', now(), now() + interval '1 day', 'private', '{}', items, null),
    (minimal, patient, 'north', now(), now() + interval '1 day', 'minimal', array['result'], items, null);
  assert (select qr_token from public.referral_intake where id = r) = 'payload.signature';
  assert (select qr_token from public.referral_intake where id = unaccepted) is null;
  assert public.referral_details(r, north, true, 'view') ->> 'status' = '409';
  assert public.referral_details(r, north, true, 'prepare_export') ->> 'status' = '409';
  assert public.referral_details(r, south, true, 'view') ->> 'status' = '404';
  assert public.manage_referral(r, north, 'review', null) ->> 'status' = '409';
  assert public.accept_referral_status(r, south) ->> 'status' = '404';
  assert public.referral_appointment(r, north, 'propose', null, start_time, '') ->> 'status' = '409';

  receipt := public.accept_referral_status(r, north);
  assert receipt ->> 'id' = r;
  assert public.accept_referral_status(r, north) = receipt;
  assert exists (select 1 from public.accept_referral(r, north));
  assert public.referral_details(r, north, false, 'view') -> 'items' = items;
  before_withdrawal := public.referral_details(r, north, false, 'prepare_export');
  assert public.record_referral_export(r, north, false, before_withdrawal, signature) ->> 'recorded' = 'true';

  assert public.manage_referral(r, other_patient, 'withdraw', 'history') ->> 'status' = '404';
  assert public.manage_referral(r, north, 'revoke', null) ->> 'status' = '403';
  assert public.manage_referral(minimal, patient, 'withdraw', 'result') ->> 'status' = '409';
  assert public.manage_referral(r, patient, 'withdraw', 'previous-result') ->> 'status' = '409';
  patient_review := public.manage_referral(r, patient, 'withdraw', 'history') -> 'review';
  assert patient_review -> 'withdrawnIds' = '["history"]'::jsonb;
  assert patient_review ->> 'noteRedacted' = 'true';
  assert public.manage_referral(r, patient, 'withdraw', 'history') -> 'review' = patient_review;
  current_snapshot := public.referral_details(r, north, true, 'prepare_export');
  assert current_snapshot -> 'items' -> 1 ->> 'text' = 'Please review the hemoglobin result at the next visit.';
  assert current_snapshot -> 'items' -> 1 ->> 'id' = 'note';
  assert jsonb_array_length(current_snapshot -> 'items') = 2;
  assert public.record_referral_export(r, north, false, before_withdrawal, signature) ->> 'status' = '409';

  assert public.manage_referral(r, north, 'request', 'Compare with earlier results') -> 'review' -> 'request' ->> 'status' = 'pending';
  assert public.manage_referral(r, patient, 'approve', null) -> 'review' -> 'request' ->> 'status' = 'approved';
  assert public.referral_details(r, north, false, 'view') -> 'items' -> 2 ->> 'id' = 'previous-result';
  assert public.manage_referral(r, patient, 'withdraw', 'previous-result') -> 'review' -> 'withdrawnIds' =
    '["history","previous-result"]'::jsonb;

  offer := public.referral_appointment(r, north, 'propose', null, start_time, 'Private instructions') -> 'appointment';
  assert offer ->> 'status' = 'proposed';
  before_confirmation := public.referral_details(r, north, false, 'prepare_export');
  assert before_confirmation -> 'appointment' = 'null'::jsonb;
  assert public.referral_appointment(r, patient, 'confirm', offer ->> 'id', null, null) -> 'appointment' ->> 'status' = 'confirmed';
  assert public.referral_appointment(r, patient, 'confirm', offer ->> 'id', null, null) -> 'appointment' ->> 'status' = 'confirmed';
  current_snapshot := public.referral_details(r, north, false, 'prepare_export');
  assert current_snapshot -> 'appointment' ->> 'status' = 'confirmed';
  assert not (current_snapshot -> 'appointment' ? 'instructions');
  assert public.record_referral_export(r, north, false, before_confirmation, signature) ->> 'status' = '409';
  assert public.record_referral_export(r, north, false, current_snapshot, 'another.receipt') ->> 'recorded' = 'true';

  assert public.manage_referral(unaccepted, patient, 'revoke', null) -> 'review' ->> 'accessStatus' = 'revoked';
  assert public.accept_referral_status(unaccepted, north) ->> 'status' = '410';
  assert not exists (select 1 from public.accept_referral(unaccepted, north));
  patient_review := public.manage_referral(r, patient, 'revoke', null) -> 'review';
  assert public.manage_referral(r, patient, 'revoke', null) -> 'review' = patient_review;
  assert public.referral_details(r, north, true, 'view') ->> 'status' = '410';
  assert public.referral_details(r, north, false, 'prepare_export') ->> 'status' = '410';
  assert public.accept_referral_status(r, north) ->> 'status' = '410';
  assert public.referral_appointment(r, north, 'propose', offer ->> 'id', start_time, '') ->> 'status' = '410';
  clinic_review := public.manage_referral(r, north, 'review', null) -> 'review';
  assert clinic_review ->> 'accessStatus' = 'revoked';
  assert not (clinic_review ? 'items');
  assert clinic_review -> 'request' = 'null'::jsonb;
  assert clinic_review -> 'events' @> '[{"kind":"export","receipt":"receipt.signature"},{"kind":"export","receipt":"another.receipt"}]'::jsonb;
  assert clinic_review -> 'events' @> '[{"kind":"revoke"},{"kind":"appointment_proposed"},{"kind":"appointment_confirmed"}]'::jsonb;

  assert public.accept_referral_status(minimal, north) ->> 'id' = minimal;
  current_snapshot := public.referral_details(minimal, north, false, 'prepare_export');
  assert public.record_referral_export(minimal, north, false, current_snapshot, signature) ->> 'recorded' = 'true';
  update public.referral_intake set expires_at = now() - interval '1 second' where id = minimal;
  assert public.referral_details(minimal, north, false, 'view') ->> 'status' = '410';
  assert public.referral_appointment(minimal, north, 'propose', null, start_time, '') -> 'appointment' ->> 'status' = 'proposed';
  clinic_review := public.manage_referral(minimal, north, 'review', null) -> 'review';
  assert clinic_review ->> 'accessStatus' = 'expired';
  assert not (clinic_review ? 'items');
  assert clinic_review -> 'events' @> '[{"kind":"export","receipt":"receipt.signature"}]'::jsonb;
  assert public.manage_referral(minimal, south, 'review', null) ->> 'status' = '404';

  assert (select count(*) = 1 from public.referral_events where referral_id = r
    and kind = 'appointment_confirmed' and actor_user = patient);
  assert (select count(*) = 1 from public.referral_events where referral_id = r
    and kind = 'appointment_proposed' and actor_user = north);
  assert (select count(*) = 2 from public.referral_events where referral_id = r
    and kind = 'export' and actor_user = north);
  assert (select count(*) = 1 from public.referral_events where referral_id = r
    and kind = 'revoke' and actor_user = patient);
  assert clinic_review::text not like '%' || north::text || '%';
end;
$$;
reset role;
