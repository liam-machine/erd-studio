# ERD Studio feedback-analysis proxy

A small Cloudflare Worker that sits between the ERD Studio extension and an
OpenAI-compatible chat-completions API, holding the API key so the extension
does not have to.

It backs the **last-resort** analysis tier described in `CLAUDE.md`: when a user
has neither a VS Code language model nor their own endpoint configured, the
Feedback dialog can post the text they typed here to get a suggested title, a
type and a duplicate check. The user's own model and the user's own endpoint
always win; this is only ever tier 3 of 4.

**Nothing in this directory is part of the extension.** It has no dependencies,
no build step and no npm install: the file that deploys is `src/index.js`
exactly as written. `proxy/**` is listed in the repo's `.vscodeignore`, so it
never ships inside the VSIX, and neither `esbuild.js`, the tsconfigs nor the npm
scripts at the repo root may come to depend on it.

---

## Read this before you deploy it

Running this Worker is a commitment, not a checkbox. Be deliberate about all
four of these:

1. **You become a data processor for other people's bug descriptions.** What
   arrives here is whatever a user typed into the Feedback dialog. In practice
   that means private dbt model names, table names, column names and internal
   project details. The extension never sends diagnostics, file paths or
   schema — `buildAnalysisPrompt()` takes no `Diagnostics` parameter by
   construction — but the prose itself is enough to be sensitive. It is
   forwarded to a third-party model provider under **your** API key, under
   their terms, not the user's.

   Because of that, filling in `HOSTED_ANALYSIS_ENDPOINT` requires filling in
   `HOSTED_ANALYSIS_PROVIDER` in the same commit, with the actual upstream
   vendor as a user should see it (`'DeepSeek'` for the default
   `UPSTREAM_URL`). The extension's consent modal names both the relay and that
   provider, and `resolveAnalysisTier()` refuses the tier outright while either
   constant is empty — so there is no build in which the endpoint is live and
   the disclosure is not. Repointing `UPSTREAM_URL` at a different vendor is a
   change of processor: it requires shipping a matching extension update, which
   also re-asks every user for consent (the stored consent is keyed to
   `<host>|<provider>`).
2. **The URL is public.** It ships inside a published VSIX, so anyone can read
   it out of the extension and call it directly. Treat it as an open endpoint
   from day one. The caps below are the only thing standing between it and your
   credit card, which is why none of them are optional.
3. **Set the account spend cap.** The daily budget in this Worker is
   best-effort: KV is eventually consistent, so a burst can slip a few requests
   past it. The provider-side cap is the hard limit. Set both.
4. **You need a way to turn it off.** That is `KILL_SWITCH`, below. Set it in
   `wrangler.toml` and deploy for a change that sticks — `[vars]` in that file
   is the source of truth, and every later `wrangler deploy` re-applies it over
   any dashboard value. The dashboard flip is the fast one, effective on the
   next request but only until the next deploy.

If any of that is not something you want to own, leave
`HOSTED_ANALYSIS_ENDPOINT` empty in `src/services/feedbackAnalysisService.ts`.
While it is empty the hosted tier does not exist, no consent modal mentioning it
can ever appear, and the extension behaves exactly as it did with three tiers.

---

## What it does

One route: `POST /chat/completions`. Every other method is `405`, every other
path is `404`, before any work happens.

| Guard | Behaviour |
|---|---|
| **Kill switch** | `KILL_SWITCH` set to anything other than `off`/`0`/`false`/`no`/empty (or the boolean `false`, or the number `0`) → `503` for every request. Checked first: no KV read, no upstream call. `[vars]` are JSON, so `KILL_SWITCH = true` is a boolean and kills as written; an unrecognised type refuses rather than serving. |
| **Body cap** | Refused at `413` while still streaming if it exceeds `MAX_BODY_BYTES` (default 24 KB; the real prompt is ~2-3 KB). `Content-Length` is checked first, but the stream is counted too — the header is a claim, not a fact. |
| **Allowlist rebuild** | The upstream body is *rebuilt*, not forwarded. Only the message list survives, and only messages with a `system`/`user`/`assistant` role and non-empty string content. `model`, `temperature`, `max_tokens` and `stream` are the server's; the client's `model` is discarded. Unknown fields (`tools`, `n`, `logprobs`, …) never reach the upstream. |
| **Per-caller limit** | Sliding window of timestamps in KV: `IP_LIMIT` requests per `IP_WINDOW_SECONDS` (default 15 / 5 min) → `429` with `Retry-After`. IPv4 is keyed by address; **IPv6 is keyed by /64**, because one consumer or VPS allocation is a whole /64 and keying on the full address would give a single caller 2^64 fresh windows. The bucket is salted and hashed before it is used as a key, and is never logged. |
| **Per-caller daily cap** | `IP_DAILY_LIMIT` requests per bucket per UTC day (default 60) → `429` with `Retry-After` until midnight. The window alone works out to thousands of requests a day — more than the whole global budget — so this is what actually stops one caller draining it. It shares the window's KV entry, so it costs no extra read or write. |
| **Daily budget** | A global counter per UTC day, `DAILY_BUDGET` (default 450, sized for the Workers Free KV write quota — see below) → `429` with `Retry-After`. **Reserved before** the upstream call, so a failing upstream cannot be retried without limit. |
| **Fail closed** | Any unexpected error — including a KV outage, which would otherwise mean "unmetered" — returns `503` and makes no upstream call. |

Two invariants the code is built around, and which any change here must keep:

- **The key never leaves.** `DEEPSEEK_API_KEY` is used in exactly one place (the
  upstream `Authorization` header) and appears in no response, no header we set
  and no log line. Upstream error bodies are **discarded rather than
  forwarded** — a `429` upstream becomes a bare `{"error":"rate_limited"}`,
  anything else becomes `502 {"error":"upstream_error"}`.
- **No prompt or completion text is ever logged.** Every value passed to `log()`
  is a literal label or a number computed in the Worker: event, status, elapsed
  ms, the day's count, and the reply's *length*. Never its content.

Success is reshaped down to the one field the extension reads:

```json
{ "choices": [ { "index": 0, "finish_reason": "stop",
                 "message": { "role": "assistant", "content": "…" } } ] }
```

There are no CORS headers. The caller is the VS Code extension host, not a
browser; a preflight is not answered and no origin is blessed.

---

## Deploy

You need a Cloudflare account and an API key for the upstream provider.
`npx wrangler` needs no global install.

```bash
cd proxy

# 1. Authenticate. Opens a browser and stores the token locally.
npx wrangler login

# 2. Create the KV namespace that holds the rate-limit windows and the
#    daily counter, then paste the printed id into wrangler.toml
#    (kv_namespaces[0].id, replacing REPLACE_WITH_KV_NAMESPACE_ID).
npx wrangler kv namespace create ANALYSIS_KV

# 3. Store the upstream API key as a SECRET. Never put it in wrangler.toml,
#    and never commit it — wrangler prompts for the value and does not echo it.
npx wrangler secret put DEEPSEEK_API_KEY

# 4. Pick a salt so the KV keys are not a bare hash of an IP address:
#    edit IP_HASH_SALT in wrangler.toml, or make it a secret as in step 3.

# 5. Review the caps in wrangler.toml — IP_LIMIT, IP_WINDOW_SECONDS,
#    IP_DAILY_LIMIT, DAILY_BUDGET, MAX_TOKENS — then deploy.
npx wrangler deploy
```

Wrangler prints the deployed URL. Smoke-test it (an empty body is a `400`, and a
`GET` is a `404`, both without touching the upstream):

```bash
curl -si -X POST https://<your-worker>.workers.dev/chat/completions \
  -H 'Content-Type: application/json' --data '{}' | head -n 1     # 400
curl -si https://<your-worker>.workers.dev/chat/completions | head -n 1  # 404
```

Then set `HOSTED_ANALYSIS_ENDPOINT` in
`src/services/feedbackAnalysisService.ts` to the **base** URL — no
`/chat/completions` suffix, the extension appends that — set
`HOSTED_ANALYSIS_PROVIDER` beside it to the upstream vendor's user-facing name,
and ship a release. Leaving the provider empty leaves the tier switched off.
Only `https:` is accepted (plus `http:` on loopback, for `wrangler dev`).

### Set the spend cap

Do this in the **upstream provider's** dashboard, not Cloudflare's: a monthly
or per-key hard limit on the key you just stored. That cap is what makes an
oversight in the daily budget survivable.

Cloudflare's limits are not free of consequence either. **Workers Free allows
1,000 KV writes per day** (reset 00:00 UTC), and this Worker performs **two KV
writes per served request** — the per-caller entry and the global daily counter
— so a free-plan account can serve roughly 500 requests a day whatever
`DAILY_BUDGET` says. Exceeding the KV write quota is not graceful: the failing
`put` propagates into the Worker's fail-closed catch, so **every** request
returns `503 {"error":"unavailable"}` until UTC midnight. It does not degrade to
`429`.

So: leave `DAILY_BUDGET` at the shipped `450` on Workers Free, and move to
Workers Paid before raising it. The shipped default deliberately leaves headroom
for the single write a budget-denied request still incurs.

### The kill switch

`wrangler.toml`'s `[vars]` is the source of truth for `KILL_SWITCH`: a
`wrangler deploy` uploads the whole variable set, so **every deploy re-applies
`KILL_SWITCH = "off"` over any value set in the dashboard**, silently
re-opening the endpoint.

- **Durable (do this)** — set `KILL_SWITCH = "on"` in `wrangler.toml` and run
  `npx wrangler deploy`. It survives every later deploy, because it *is* what
  later deploys apply.
- **Fast (dashboard)** — Workers & Pages → `erd-studio-feedback-proxy` →
  Settings → Variables → set `KILL_SWITCH` to `on` → Deploy. Effective on the
  next request, but only until someone runs `wrangler deploy` for any other
  reason. Mirror the flip into `wrangler.toml` immediately, or it will be
  undone by a change that had nothing to do with it.
- **Deploy-proof, for a real incident** — `npx wrangler secret delete
  DEEPSEEK_API_KEY`. Secrets are untouched by `wrangler deploy`, and
  `callUpstream()` returns `503` with no key. `npx wrangler delete` removes the
  Worker outright.

Every request then returns `503 {"error":"unavailable"}` immediately. The
extension treats that exactly like an unreachable model: the Feedback dialog
reports the analysis unavailable and stays completely usable, and the report
still files. Turning it off degrades a convenience; it breaks nothing.

### Watch it

```bash
npx wrangler tail --format pretty
```

You will see lines like
`{"at":"…","event":"ok","status":200,"ms":1840,"daily":37,"content_chars":612}`
and `{"at":"…","event":"denied","status":429,"reason":"ip_window","ms":6}`.
Counts, statuses and fixed labels — that is the whole vocabulary. If you ever
find yourself wanting to add the prompt to a log line to debug something, add a
counter instead.

A run of `{"event":"error","status":503,…,"kind":"…"}` lines with a KV error
name, starting part-way through a day and clearing at 00:00 UTC, is the
Cloudflare **KV daily write cap** — not the model provider. See "Set the spend
cap" above.

---

## Local development

```bash
npx wrangler dev            # http://127.0.0.1:8787
```

`wrangler dev` uses a local KV simulation, so the limits work without touching
the deployed namespace. Point the extension at it by temporarily setting
`HOSTED_ANALYSIS_ENDPOINT` to `http://127.0.0.1:8787` — loopback `http:` is the
one plaintext URL `safeBaseUrl()` allows — or use
`setHostedAnalysisTargetForTests()` from a unit test.

## Checks

```bash
npm test     # 48 assertions, Node's built-in runner, nothing to install
npm run check  # node --check, then tsc --noEmit over the JSDoc types (strict)
```

The tests drive the Worker's `fetch` handler against an in-memory KV and a
stubbed upstream, and cover the routing, the kill switch, the allowlist
rebuild, both limiters, upstream failures and the fail-closed paths. The last
group is the one that matters most: it captures **every** log line emitted
across the whole run and asserts that none of them contains the API key, the
prompt, the completion or the caller's IP. If you change the logging, that
group is what tells you whether you broke the promise this Worker makes to the
people whose bug reports pass through it.

They are invisible to the repo's vitest suite (whose `include` is
`test/unit/**` at the root) and nothing at the root runs them.
`proxy/tsconfig.json` is likewise local to this directory and is not referenced by the
root build (the root `tsconfig.json` includes only `src/**/*`). `npm run
compile`, `npm run build` and `npm test` at the repo root must stay green in a
clone that has never touched this directory.
