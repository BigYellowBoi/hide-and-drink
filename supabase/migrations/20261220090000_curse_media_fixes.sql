-- Curse media fixes (19/11/26).
--
-- Content only: the app reads these params (src/cards/state.ts, nothing new on the server).
-- * Drinks All Round: params.proof 'photo', so each team sends a drink photo like Cheers.
-- * Sculling: free to cast (the hiders' chug video is the cost), and the hider judges the
--   seekers' video against their own: params.judge_question "Who drank quicker?" with
--   judge_accept (clears it) and judge_reject (the seekers go again).
-- * Distant Cuisine: the hiders send a photo of their restaurant first (hider_proof), so the
--   seekers know which country to beat.
-- * Every curse with proof says what to send (hider_proof_prompt, proof_prompt), and the ones
--   the hider compares get judge labels.
-- Library edits win: existing keys are kept, text and cost change only if still the seed's.

update public.cards set params = '{"proof": "photo"}'::jsonb || params where id = 'drinks_all_round';
update public.cards set params = '{"hider_proof_prompt": "Film your team chugging a schooner / pint in one take. This is the casting cost.", "proof_prompt": "Film yourselves chugging a schooner / pint quicker than the hiders.", "judge_question": "Who drank quicker?", "judge_accept": "Seekers", "judge_reject": "Hiders"}'::jsonb || params where id = 'sculling';
update public.cards set params = '{"hider_proof": "photo", "hider_proof_prompt": "Photo of your restaurant or its menu, showing which country the food is from.", "proof_prompt": "Photo at a restaurant serving food from a country further away.", "judge_question": "Is their country further away?", "judge_accept": "Yes", "judge_reject": "No"}'::jsonb || params where id = 'distant_cuisine';
update public.cards set params = '{"hider_proof_prompt": "Unzoomed Street View screenshot from a street within 150 m of the seekers: level with the horizon, with a structure other than a road in it.", "proof_prompt": "Photo of the same spot in real life.", "judge_question": "Is it the same spot?", "judge_accept": "Yes", "judge_reject": "No"}'::jsonb || params where id = 'unguided_tourist';
update public.cards set params = '{"hider_proof_prompt": "Film a bird in one take, up to 5 minutes. Stop when it leaves the frame.", "proof_prompt": "Film a bird for at least as long as the hiders'' video.", "judge_question": "Did the seekers film their bird for as long or longer?", "judge_accept": "Yes", "judge_reject": "No, shorter"}'::jsonb || params where id = 'bird_guide';
update public.cards set params = '{"hider_proof_prompt": "Photo of a car.", "proof_prompt": "Photo of a more expensive car.", "judge_question": "Is the seekers'' car more expensive?", "judge_accept": "Yes", "judge_reject": "No"}'::jsonb || params where id = 'luxury_car';
update public.cards set params = '{"hider_proof_prompt": "Photo of the drink on your bar''s menu (any branded alcohol).", "proof_prompt": "Photo of you drinking the same drink.", "judge_question": "Is it the same drink?", "judge_accept": "Yes", "judge_reject": "No"}'::jsonb || params where id = 'menu';
update public.cards set params = '{"proof_prompt": "Photo of you under a bridge."}'::jsonb || params where id = 'bridge';
update public.cards set params = '{"proof_prompt": "Photo of your pokies win."}'::jsonb || params where id = 'pokies';
update public.cards set params = '{"proof_prompt": "Screenshot of your win against the hiders."}'::jsonb || params where id = 'clash';
update public.cards set params = '{"proof_prompt": "Photo of the shots you rolled."}'::jsonb || params where id = 'hammered';
update public.cards set params = '{"proof_prompt": "Photo of the pool table after you lost."}'::jsonb || params where id = 'quan';
update public.cards set params = '{"proof_prompt": "Photo inside the Chinese restaurant or in Chinatown."}'::jsonb || params where id = 'louis';
update public.cards set params = '{"proof_prompt": "Photo inside KFC or of the watermelon-flavoured thing."}'::jsonb || params where id = 'cruz';
update public.cards set cast_cost = 'free' where id = 'sculling' and cast_cost = 'drink';
update public.cards set body = 'Hiders get one chance to chug a schooner / pint on video (that is the casting cost, no extra drink). Seekers can''t use transport until they chug one quicker on video. The hiders watch both and pick who was quicker.' where id = 'sculling' and body = 'Hiders get one chance to chug a schooner / pint and time it. Seekers can''t use transport until they are able to chug a schooner / pint quicker.';
