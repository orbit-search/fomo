<h1 align="center">FOMO</h1>

<p align="center">
  <img src="public/fomo-mark.svg" width="168" height="168" alt="FOMO orbital mark" />
</p>

**Firecrawl · Orbit · Monid · OpenRouter.** A new agent stack for exploring the web, understanding people, and putting tools to work.

Ask FOMO to read a page, learn about a person, or discover the right tool for a task. See the answer beside its sources, browser captures, people profiles, and execution receipts. Choose a model, inspect what ran, and stop work at any time.

## The stack

| Layer | Provider | What it does |
| --- | --- | --- |
| Browsing | [Firecrawl](https://docs.firecrawl.dev/features/browser) | Web search, Markdown reading, page captures, and an isolated browser reused within a conversation |
| People | [Orbit](https://docs.orbitsearch.com) | Natural-language people search, public profile context, and cited sources |
| Tools | [Monid](https://docs.monid.ai) | Discover endpoints, inspect their exact schemas and prices, execute approved calls, and follow asynchronous runs |
| Models | [OpenRouter](https://openrouter.ai/docs/guides/features/tool-calling) | Stream model responses and function calls, with model and provider routing and configured fallbacks |

One Node.js process serves a React interface and a TypeScript agent loop. SQLite keeps conversations, events, artifacts, confirmations, and operation receipts on disk. No local browser installation or agent sidecar is required.

## Run locally

```sh
pnpm install --frozen-lockfile
cp .env.example .env.local
```

Set the keys in your private `.env.local`:

```dotenv
OPENROUTER_API_KEY=...
FIRECRAWL_API_KEY=...
ORBIT_API_KEY=...
MONID_API_KEY=...
FOMO_MODELS=openai/gpt-6.1-terra,anthropic/claude-sonnet-5.5
```

An OpenRouter key is required to chat. Each other key enables its provider’s tools; an absent key leaves that capability unavailable. FOMO never silently substitutes another provider. Orbit needs `search:read` and `profile:read` scopes. Set `MONID_WORKSPACE_ID` only when your account requires an explicit workspace.

```sh
pnpm dev
```

Open **http://127.0.0.1:4330**. Frontend edits reload through Vite; restart the process after changing server code or environment variables. Send with the button or **Ctrl / ⌘ + Enter**. Enter adds a new line.

Try:

- “Read this company’s website and summarize its product, citing the page.”
- “Find Linus Torvalds with Orbit, then tell me about his work with sources.”
- “Discover tools for company information. Inspect the best match and explain its input and price.”
- “Use the Firecrawl browser to open this site and inspect its form before doing anything.”

The Workspace tabs show real artifacts as they arrive. The conversation’s tool trace shows calls and results. No sample people, conversations, or tool output are inserted into a new instance.

## Model routing

FOMO defaults to [GPT‑6.1 Terra](https://openrouter.ai/openai/gpt-6.1-terra), with [Claude Sonnet 5.5](https://openrouter.ai/anthropic/claude-sonnet-5.5) as its fallback. See the [model guide](docs/models.md) for the current choices and release sources.

`FOMO_MODELS` is a comma-separated priority list of up to five tool-capable OpenRouter model IDs. “Auto route” sends that list to OpenRouter for fallback routing. Selecting a model moves it to the front; the remaining configured models stay available as fallbacks. The conversation records the model that actually answered.

FOMO requests supported tool parameters and handles streamed argument fragments. Tools execute sequentially even if a model returns multiple calls. A turn is capped at 16 model steps, each completion at 4,096 output tokens, and the stored history has a bounded context limit. Start a new session when that limit is reached.

## Actions and receipts

Monid follows **discover → inspect → validate → confirm → execute**. It validates the exact input sections against the inspected schema. Before execution, the interface shows arguments and provider pricing. Confirmation applies only to that exact call. Browser clicks, fills, and keypresses also pause for confirmation. Opening, reading, and scrolling do not require a separate confirmation.

Identical Orbit searches reuse their request receipt; profile reads keep stable idempotency keys. Monid submissions are journaled before sending, and identical inputs reuse the original result. A connection loss after a paid submission is **uncertain**, not permission to resubmit it. Review recent runs at [Monid](https://app.monid.ai) before repeating an uncertain call.

Stop cancels the local model/tool loop and closes the known Firecrawl browser. An already-submitted remote job may continue. Browser TTLs bound unknown or lost browser creations. Restart recovery repairs unfinished tool-message pairs and marks the turn interrupted; it never automatically replays paid or state-changing work. Monid `BLOCKED`, `FAILED`, `STOPPED`, and `TIME_OUT` are terminal, distinct from a successful provider response.

## Production preview

```sh
pnpm build
# Set a private random token of at least 32 characters in .env.local:
# FOMO_OPERATOR_TOKEN=...
pnpm start
```

Production refuses to start without that token. Unlock the interface with it; the browser receives an HttpOnly, SameSite cookie. API clients may use `Authorization: Bearer <operator-token>`. Provider keys never go to the browser. The server binds to loopback and validates Host and Origin headers. Keep it on loopback; adding public hosting is a separate authentication and user-isolation project.

This release supports **one trusted operator per local instance**. Each developer uses their own keys and local `.fomo/fomo.sqlite` journal. The database contains conversations and provider output; protect the machine and storage. It is not an encrypted vault or a multi-user service. Do not commit `.env.local`, `.fomo`, provider credentials, or browser state.

## Verify and improve

```sh
pnpm check
```

This runs the credential-free provider fixtures, agent-loop and access-boundary tests, lint, type checking, and production build. Fixtures cover fragmented tool calls, invalid streams, confirmations, cancellation, restart recovery, provider errors, operation receipts, source normalization, and rich Orbit profiles.

Live checks are separate opt-ins and **use provider credits**:

```sh
FOMO_LIVE_EVAL=1 pnpm eval:live
# Also execute exactly one London weather lookup, quoted at $0.05 by Monid:
FOMO_LIVE_EVAL=1 FOMO_LIVE_MONID=1 pnpm eval:live
```

The live suite checks OpenRouter function calling, Firecrawl search/read/capture/browser reuse and cleanup, Orbit search/profile sources, and Monid discovery/schema inspection. The second command additionally executes the exact inspected weather call and verifies its terminal result. Reports in ignored `.fomo/quality/` record the revision, dirty state, outcomes, and timing; they exclude keys and raw profiles. A green fixture suite is not live provider evidence.

See [architecture](docs/architecture.md) and [quality evidence](docs/quality.md) for boundaries and release checks.

## License

Provider logos remain the property of their respective owners.

[MIT](LICENSE).
