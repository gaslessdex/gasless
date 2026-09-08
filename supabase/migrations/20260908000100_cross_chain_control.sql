insert into public.system_controls (control_key, enabled)
values ('cross_chain', false)
on conflict (control_key) do nothing;
