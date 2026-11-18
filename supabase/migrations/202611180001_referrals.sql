create table public.referral_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  clinic text check (clinic in ('north', 'south'))
);

create table public.referral_intake (
  id text primary key,
  patient_id uuid not null references auth.users(id) on delete cascade,
  clinic text not null check (clinic in ('north', 'south')),
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  items jsonb not null check (jsonb_typeof(items) = 'array'),
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null
);

create index referral_intake_patient on public.referral_intake (patient_id, issued_at desc);
create index referral_intake_clinic on public.referral_intake (clinic, accepted_at desc);
alter table public.referral_accounts enable row level security;
alter table public.referral_intake enable row level security;
revoke all on public.referral_accounts, public.referral_intake from public, anon, authenticated;
grant select on public.referral_accounts to service_role;
grant select, insert, update on public.referral_intake to service_role;

create function public.accept_referral(referral_id text, staff_user uuid)
returns table (id text, accepted_at timestamptz)
language sql
security invoker
set search_path = ''
as $$
  update public.referral_intake as r
  set accepted_at = coalesce(r.accepted_at, now()),
      accepted_by = coalesce(r.accepted_by, staff_user)
  from public.referral_accounts as a
  where r.id = referral_id and a.user_id = staff_user and r.clinic = a.clinic
    and (r.accepted_at is not null or r.expires_at > now())
  returning r.id, r.accepted_at;
$$;
revoke execute on function public.accept_referral(text, uuid) from public, anon, authenticated;
grant execute on function public.accept_referral(text, uuid) to service_role;
