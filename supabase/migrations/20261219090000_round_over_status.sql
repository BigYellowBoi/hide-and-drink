-- Between rounds: the round is over (seekers found the hiders, or the host redoes it) and the
-- next round's hiders start it when they're ready (20261219090100_rounds_scoring.sql).
-- On its own: a new enum value can't be used in the transaction that adds it.
alter type public.game_status add value if not exists 'round_over' before 'ended';
