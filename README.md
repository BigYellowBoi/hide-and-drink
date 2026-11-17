# Hide + Drink

Companion web app for our Hide + Drink variant of Jet Lag: The Game Hide and Seek.

- Brief for Claude Code: `CLAUDE.md`
- Full spec: `docs/spec.md`
- Seed data (cards, questions, config, play areas): `data/`

## One-time setup

1. **Turn on GitHub Pages:** repo Settings > Pages > Build and deployment > Source: **GitHub Actions**.
2. **Add the Supabase values:** in Supabase, open Project Settings > API and copy the Project URL and the anon public key. In this repo go to Settings > Secrets and variables > Actions > **Variables** tab and add:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
3. **Redeploy:** Actions tab > "Test and deploy to GitHub Pages" > Run workflow.
4. Open `https://bigyellowboi.github.io/hide-and-drink/` on your phone and use Add to Home Screen.

## Local development

```bash
npm install
cp .env.example .env.local   # then fill in the two values
npm run dev
```

`npm test`, `npm run lint` and `npm run build` must pass before merging; CI runs them on every pull request.
