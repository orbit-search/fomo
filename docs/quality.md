# Quality evidence and release checks

Keep static, live-provider, browser-interface, and hosting evidence separate.

## Static gate

Run `pnpm check` on Node 24 with a frozen lockfile. The fixture suite covers:

- OpenRouter SSE framing, fragmented function calls, actual routing metadata, usage, incomplete streams, and provider authentication failures.
- Monid inspection, composite schema validation, exact input forwarding, operation receipt reuse, canonical input ordering, uncertain submissions, foreign-run rejection, terminal controls, and downstream provider errors.
- Firecrawl browser reuse, owned-resource cleanup, failed close retention, exception responses, URL restrictions, and confirmation before interaction.
- Orbit v3 normalization, source links, stable search IDs, ownership, mismatched identities, and rich profiles exceeding 2 MB.
- Agent event/message ordering, duplicate client submissions, exact-session approval, denied calls, cancellation, restart recovery, and local API authentication/Origin/Host boundaries.

A passing test suite proves these fixture scenarios. It does not establish live provider availability or support arbitrary Monid endpoint schemas.

## Live provider gate

`FOMO_LIVE_EVAL=1 pnpm eval:live` uses the configured providers. `FOMO_LIVE_MONID=1` additionally authorizes its exact one-city weather fixture. Review the current inspected price before using that flag. The suite creates an isolated local journal and closes its Firecrawl browser. Reports are ignored by Git.

The report must say `status: completed`, `passed: true`, identify the tested revision, and match the current worktree state. A partial report, skipped provider, configured key, or green CI is not a live pass. Preserve a failed report before replacing it when investigating a regression.

The first live run found that OpenRouter's selected providers reject `parallel_tool_calls` under strict parameter routing. FOMO removed that unsupported optional parameter and retains sequential execution in its own runtime. It also caught a stale assertion about the content of example.com; the browser fixture now reads IANA's actual public documentation page and verifies its title/content and capture.

## Manual interface gate

Use the in-app browser. Check:

1. A real OpenRouter response calls Firecrawl, produces an answer with a real source link, and displays a page capture.
2. A real Orbit search/profile read produces a People artifact and source disclosures.
3. A Monid call pauses with exact arguments and quoted price. Decline it and verify the agent records the denial without running it.
4. Stop during work, then send another request. Reload and switch sessions without losing events or duplicating the submission.
5. Choose a configured model and inspect the actual model receipt. Navigate artifact tabs with the keyboard.
6. At 390px width, check both Conversation and Workspace, open the session navigation, and verify no horizontal overflow.
7. Check keyboard focus and close behavior on stack settings and deletion confirmation.

## Production preview gate

Build, then run `pnpm start` with an operator token of at least 32 characters. Use a separate `FOMO_DATA_DIR` when a development process is already using its own local journal. Check the actual static UI route, an unauthenticated API rejection, authenticated status/session access, and a completed conversation. Keep the server on loopback.

Public deployment is outside this developer release. It requires a separate access, isolation, and storage design. Do not infer hosting readiness from the local production preview.
