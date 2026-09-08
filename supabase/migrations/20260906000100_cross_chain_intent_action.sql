alter table public.transaction_intents
  drop constraint if exists transaction_intents_action_type_check;

alter table public.transaction_intents
  add constraint transaction_intents_action_type_check
  check (action_type in ('DEVNET_PROOF','CLEAN_CLAIM','CLEAN_RECOVER','CLEAN_BURN','SWAP','SEND','CROSS_CHAIN'));
