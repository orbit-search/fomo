/** A new research workspace: session navigation, streamed answers, tool trace, and confirmations. */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowUp,
  ArrowUpRight,
  Plus,
  Stop,
  SidebarSimple,
  X,
  SlidersHorizontal,
  ChatCircle,
  CircleNotch,
  Check,
  CaretRight,
  Trash,
  SignIn,
  WarningCircle,
} from '@phosphor-icons/react';
import type { Approval, Event, Provider, Session, Snapshot } from '../shared/types';
import { api, ApiError } from './api';
import Markdown from './Content';
import Workspace, { Brand, Connections } from './Workspace';
interface Status {
  models: string[];
  providers: Record<string, { configured: boolean }>;
}
function Transcript({ events }: { events: Event[] }) {
  const turns = new Map<string, Event[]>();
  for (const e of events) {
    const group = turns.get(e.turnId) ?? [];
    group.push(e);
    turns.set(e.turnId, group);
  }
  return (
    <>
      {[...turns].map(([id, items]) => {
        const user = items.find((e) => e.kind === 'user');
        const calls = items.filter((e) => e.kind === 'tool_start');
        const answers = items.filter((e) => e.kind === 'answer');
        const text = answers.length
          ? String(answers.at(-1)!.data.text)
          : items
              .filter((e) => e.kind === 'delta')
              .map((e) => String(e.data.text))
              .join('');
        const error = items.filter((e) => e.kind === 'error').at(-1);
        const done = items.some((e) => e.kind === 'done');
        const model = items.filter((e) => e.kind === 'route').at(-1)?.data.model;
        return (
          <section className="turn" key={id}>
            {user && (
              <div className="user-message">
                <span className="message-label">You</span>
                <p>{String(user.data.text)}</p>
              </div>
            )}
            <div className="assistant-message">
              <div className="assistant-heading">
                <span className="mini-wordmark">F.</span>
                <span>FOMO</span>
                {!done && <CircleNotch className="spin" size={14} />}
              </div>
              {calls.length > 0 && (
                <details className="execution-trace" open={!done}>
                  <summary>
                    {calls.length} {calls.length === 1 ? 'tool call' : 'tool calls'}
                    <CaretRight size={12} />
                  </summary>
                  <div>
                    {calls.map((c) => {
                      const end = items.find(
                        (e) => e.kind === 'tool_end' && e.data.callId === c.data.callId,
                      );
                      const result = end?.data.result as Record<string, unknown> | undefined;
                      return (
                        <details key={String(c.data.callId)} className="trace-call">
                          <summary>
                            {end ? (
                              result?.error ? (
                                <WarningCircle size={14} />
                              ) : (
                                <Check size={14} />
                              )
                            ) : (
                              <CircleNotch className="spin" size={14} />
                            )}
                            <span>{String(c.data.name).replaceAll('_', ' ')}</span>
                            <span className="trace-state">
                              {end ? (result?.error ? 'Error' : 'Done') : 'Working'}
                            </span>
                          </summary>
                          {end && (
                            <pre>
                              {JSON.stringify({ arguments: c.data.arguments, result }, null, 2)}
                            </pre>
                          )}
                        </details>
                      );
                    })}
                  </div>
                </details>
              )}
              {text && <Markdown text={text} />}{' '}
              {!text && !done && !calls.length && (
                <p className="thinking">
                  Connecting the dots<span>…</span>
                </p>
              )}
              {error && (
                <div className="inline-error" role="status">
                  <WarningCircle size={16} />
                  <span>{String(error.data.message)}</span>
                </div>
              )}
              {done && Boolean(model) && <div className="model-receipt mono">{String(model)}</div>}
            </div>
          </section>
        );
      })}
    </>
  );
}
function Confirmation({
  approval,
  onDecision,
}: {
  approval: Approval;
  onDecision: (id: string, yes: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <section className="confirmation" aria-label="Action confirmation">
      <div className="confirmation-heading">
        <SlidersHorizontal size={19} />
        <div>
          <b>{String(approval.detail.summary ?? 'Confirm action')}</b>
          <p>Review before FOMO continues.</p>
        </div>
      </div>
      {approval.detail.price !== undefined && (
        <details open>
          <summary>Provider pricing</summary>
          <pre>{JSON.stringify(approval.detail.price, null, 2)}</pre>
        </details>
      )}
      <details open>
        <summary>Exact arguments</summary>
        <pre>{JSON.stringify(approval.args, null, 2)}</pre>
      </details>
      {Boolean(approval.detail.note) && <p>{String(approval.detail.note)}</p>}
      {error && <p className="error">{error}</p>}
      <div className="confirmation-actions">
        <button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onDecision(approval.id, false).catch((e) => {
              setError(String(e));
              setBusy(false);
            });
          }}
        >
          Decline
        </button>
        <button
          className="primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onDecision(approval.id, true).catch((e) => {
              setError(String(e));
              setBusy(false);
            });
          }}
        >
          Approve this call
          <ArrowUpRight size={14} />
        </button>
      </div>
    </section>
  );
}
export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState<string | null>(() =>
    localStorage.getItem('fomo:session'),
  );
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState('');
  const [model, setModel] = useState('');
  const [error, setError] = useState('');
  const [locked, setLocked] = useState(false);
  const [token, setToken] = useState('');
  const [sending, setSending] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [settings, setSettings] = useState(false);
  const [mobilePanel, setMobilePanel] = useState('conversation');
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const cursor = useRef(0);
  const activeId = useRef(selected);
  const bottom = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const request = useRef<{ text: string; clientId: string } | null>(null);
  async function load() {
    try {
      const [st, list] = await Promise.all([api<Status>('/status'), api<Session[]>('/sessions')]);
      setStatus(st);
      setSessions(list);
      setLocked(false);
      setError('');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setLocked(true);
      else setError(e instanceof Error ? e.message : 'Could not connect.');
    }
  }
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    activeId.current = selected;
    cursor.current = 0;
    setSnapshot(null);
    follow.current = true;
    if (selected) localStorage.setItem('fomo:session', selected);
    else localStorage.removeItem('fomo:session');
  }, [selected]);
  useEffect(() => {
    if (!selected || locked) return;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const id = selected;
    async function poll() {
      try {
        const data = await api<Snapshot>(`/sessions/${id}?after=${cursor.current}`);
        if (cancelled || activeId.current !== id) return;
        cursor.current = data.events.at(-1)?.id ?? cursor.current;
        setSnapshot((prev) => ({
          ...data,
          events: [...(prev?.session.id === id ? prev.events : []), ...data.events],
        }));
        setSessions((prev) => prev.map((s) => (s.id === id ? data.session : s)));
        setError('');
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) {
          setSelected(null);
          void load();
          return;
        }
        if (e instanceof ApiError && e.status === 401) setLocked(true);
        else setError(e instanceof Error ? e.message : 'Connection lost.');
      }
      if (!cancelled) timeout = setTimeout(() => void poll(), 750);
    }
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [selected, locked]);
  const eventCount = snapshot?.events.length ?? 0;
  useEffect(() => {
    if (!settings && !confirmDelete) return;
    const opener = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLButtonElement>('button')?.focus();
    function trap(event: KeyboardEvent) {
      if (event.key !== 'Tab') return;
      const targets = dialog?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], input, select',
      );
      if (!targets?.length) return;
      const first = targets[0],
        last = targets[targets.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', trap);
    return () => {
      document.removeEventListener('keydown', trap);
      opener?.focus();
    };
  }, [settings, confirmDelete]);
  useEffect(() => {
    if (follow.current) bottom.current?.scrollIntoView({ block: 'end', behavior: 'instant' });
  }, [eventCount]);
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setSidebar(false);
        setSettings(false);
        setConfirmDelete(false);
      }
    }
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  const running = sending || Boolean(snapshot && snapshot.session.status !== 'idle');
  const pending = snapshot?.approvals.filter((a) => a.status === 'pending') ?? [];
  async function newSession() {
    if (sending) return;
    setSelected(null);
    setDraft('');
    request.current = null;
    setError('');
    setSidebar(false);
    textarea.current?.focus();
  }
  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (!draft.trim() || running) return;
    setSending(true);
    setError('');
    const text = draft.trim();
    let id = selected;
    const req =
      request.current?.text === text ? request.current : { text, clientId: crypto.randomUUID() };
    request.current = req;
    try {
      if (!id) {
        const s = await api<Session>('/sessions', 'POST', {});
        id = s.id;
        activeId.current = id;
        setSessions((prev) => [s, ...prev]);
        setSelected(id);
      }
      await api(`/sessions/${id}/messages`, 'POST', { ...req, model: model || undefined });
      setDraft('');
      request.current = null;
      follow.current = true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send. Your draft is saved here.');
    } finally {
      setSending(false);
    }
  }
  async function stop() {
    if (!selected) return;
    try {
      await api(`/sessions/${selected}/stop`, 'POST', {});
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not stop.');
    }
  }
  async function decision(id: string, yes: boolean) {
    await api(`/sessions/${selected}/approvals/${id}`, 'POST', { approved: yes });
    setSnapshot((prev) =>
      prev
        ? {
            ...prev,
            approvals: prev.approvals.map((a) =>
              a.id === id ? { ...a, status: yes ? 'approved' : 'denied' } : a,
            ),
          }
        : prev,
    );
  }
  async function remove() {
    if (!selected) return;
    setDeleting(true);
    try {
      await api(`/sessions/${selected}`, 'DELETE', {});
      setSessions((prev) => prev.filter((s) => s.id !== selected));
      setSelected(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete session.');
    } finally {
      setDeleting(false);
    }
  }
  if (locked)
    return (
      <div className="unlock">
        <div className="wordmark">FOMO</div>
        <h1>
          Your stack.
          <br />
          Your workspace.
        </h1>
        <p>Enter the operator token configured on this server.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void api('/login', 'POST', { token })
              .then(() => {
                setToken('');
                void load();
              })
              .catch((e) => setError(e.message));
          }}
        >
          <label htmlFor="operator-token">Operator token</label>
          <input
            type="password"
            id="operator-token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="current-password"
            required
          />
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="primary">
            Unlock workspace
            <SignIn />
          </button>
        </form>
      </div>
    );
  return (
    <div className="app-shell">
      <a className="skip-link" href="#prompt">
        Skip to prompt
      </a>
      <nav className={`sidebar ${sidebar ? 'is-open' : ''}`} aria-label="Sessions">
        <div className="sidebar-brand">
          <a href="/" className="wordmark" aria-label="FOMO home">
            FOMO
          </a>
          <button
            className="icon-button mobile-close"
            onClick={() => setSidebar(false)}
            aria-label="Close sessions"
          >
            <X />
          </button>
        </div>
        <p className="sidebar-descriptor">The connected agent stack.</p>
        <button className="new-session" onClick={() => void newSession()}>
          <Plus size={17} />
          New session<span className="mono">+</span>
        </button>
        <div className="session-heading">
          Your sessions<span>{sessions.length}</span>
        </div>
        <div className="session-list">
          {sessions.length ? (
            sessions.map((s) => (
              <button
                className={selected === s.id ? 'selected' : ''}
                key={s.id}
                onClick={() => {
                  setSelected(s.id);
                  setSidebar(false);
                  setError('');
                }}
              >
                <ChatCircle size={16} />
                <span>{s.title}</span>
                {s.status !== 'idle' && <CircleNotch className="spin" size={12} />}
              </button>
            ))
          ) : (
            <p className="sidebar-empty">
              A fresh start.
              <br />
              Your sessions will live here.
            </p>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="stack-mini">
            {(Object.keys(brandsList) as Provider[]).map((p) => (
              <Brand key={p} provider={p} />
            ))}
          </div>
          <button className="stack-settings" onClick={() => setSettings(true)}>
            <span>Four tools. One conversation.</span>
            <SlidersHorizontal size={17} />
          </button>
          <span className="local-note mono">LOCAL WORKSPACE</span>
        </div>
      </nav>
      {sidebar && (
        <button
          className="nav-backdrop"
          aria-label="Close session navigation"
          onClick={() => setSidebar(false)}
        />
      )}
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button"
              onClick={() => setSidebar(!sidebar)}
              aria-label="Toggle sessions"
            >
              <SidebarSimple size={21} />
            </button>
            <span>Workspace</span>
            <CaretRight size={12} />
            <b>{snapshot?.session.title ?? 'New session'}</b>
          </div>
          <div className="topbar-actions">
            <span className={`agent-status ${running ? 'working' : ''}`}>
              {pending.length ? 'Needs your input' : running ? 'Working' : 'Ready'}
            </span>
            <button
              className="icon-button"
              onClick={() => setSettings(true)}
              aria-label="Stack settings"
            >
              <SlidersHorizontal size={19} />
            </button>
            {selected && (
              <button
                className="icon-button"
                onClick={() => setConfirmDelete(true)}
                disabled={deleting || running}
                aria-label="Delete conversation"
              >
                <Trash size={17} />
              </button>
            )}
          </div>
        </header>
        <div className="mobile-view-tabs">
          <button
            className={mobilePanel === 'conversation' ? 'active' : ''}
            onClick={() => setMobilePanel('conversation')}
          >
            Conversation
          </button>
          <button
            className={mobilePanel === 'workspace' ? 'active' : ''}
            onClick={() => setMobilePanel('workspace')}
          >
            Workspace {snapshot?.artifacts.length ? `(${snapshot.artifacts.length})` : ''}
          </button>
        </div>
        <main className={`content-grid show-${mobilePanel}`}>
          <div className="conversation-column">
            <div
              className="conversation-scroll"
              onScroll={(e) => {
                const el = e.currentTarget;
                follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
              }}
            >
              {!snapshot?.events.length ? (
                <div className="welcome">
                  <div className="welcome-kicker">
                    <span className="mini-wordmark">F.</span>Connected by design.
                  </div>
                  <h1>
                    Less searching.
                    <br />
                    <span>More figuring it out.</span>
                  </h1>
                  <p>
                    Explore the web. Understand the people.
                    <br />
                    Put the right tools to work.
                  </p>
                  <div className="prompt-suggestions">
                    <button
                      onClick={() => {
                        setDraft(
                          'Read https://firecrawl.dev and summarize what it offers, citing the page.',
                        );
                        textarea.current?.focus();
                      }}
                    >
                      <Brand provider="firecrawl" />
                      <span>
                        <b>Get the whole picture</b>
                        <small>Read a page and pull out what matters</small>
                      </span>
                      <ArrowUpRight />
                    </button>
                    <button
                      onClick={() => {
                        setDraft(
                          'Find Linus Torvalds with Orbit, read his public profile, and give me a short cited brief about his work.',
                        );
                        textarea.current?.focus();
                      }}
                    >
                      <Brand provider="orbit" />
                      <span>
                        <b>Meet the person behind the name</b>
                        <small>Find someone and understand their work</small>
                      </span>
                      <ArrowUpRight />
                    </button>
                    <button
                      onClick={() => {
                        setDraft(
                          'Discover Monid tools for company information. Inspect the best match and show me its schema and pricing before running anything.',
                        );
                        textarea.current?.focus();
                      }}
                    >
                      <Brand provider="monid" />
                      <span>
                        <b>There’s a tool for that</b>
                        <small>Discover the right capability for a task</small>
                      </span>
                      <ArrowUpRight />
                    </button>
                  </div>
                </div>
              ) : (
                <div className="transcript" role="log" aria-label="Conversation">
                  <Transcript events={snapshot.events} />
                </div>
              )}
              {pending.map((a) => (
                <Confirmation key={a.id} approval={a} onDecision={decision} />
              ))}
              <div ref={bottom} />
            </div>
            <div className="composer-wrap">
              {error && (
                <div className="inline-error" role="alert">
                  <WarningCircle size={16} />
                  <span>{error}</span>
                  <button
                    className="icon-button"
                    onClick={() => setError('')}
                    aria-label="Dismiss error"
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
              <form
                className={`composer ${running ? 'is-running' : ''}`}
                onSubmit={(e) => void send(e)}
              >
                <label className="sr-only" htmlFor="prompt">
                  Message FOMO
                </label>
                <textarea
                  id="prompt"
                  ref={textarea}
                  placeholder="Ask a question. Find a person. Make something happen."
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  rows={3}
                />
                <div className="composer-bottom">
                  <label className="model-select">
                    <Brand provider="openrouter" />
                    <select
                      aria-label="Model routing"
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      disabled={running}
                    >
                      <option value="">Auto route</option>
                      {status?.models.map((m) => (
                        <option key={m} value={m}>
                          {m.split('/').at(-1)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="send-controls">
                    <span className="shortcut mono">⌘ ↵</span>
                    {running ? (
                      <button
                        className="send stop"
                        type="button"
                        aria-label="Stop agent"
                        onClick={() => void stop()}
                      >
                        <Stop weight="fill" size={16} />
                      </button>
                    ) : (
                      <button
                        className="send"
                        aria-label="Send message"
                        disabled={!draft.trim() || !status?.providers.openrouter?.configured}
                      >
                        <ArrowUp size={20} />
                      </button>
                    )}
                  </div>
                </div>
              </form>
              <p className="composer-footnote">Powered by Firecrawl, Orbit, Monid & OpenRouter.</p>
            </div>
          </div>
          <Workspace artifacts={snapshot?.artifacts ?? []} providers={status?.providers ?? {}} />
        </main>
      </div>
      {settings && (
        <div className="modal-backdrop" onClick={() => setSettings(false)}>
          <section
            ref={dialogRef}
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="icon-button modal-close"
              onClick={() => setSettings(false)}
              aria-label="Close settings"
            >
              <X />
            </button>
            <span className="mini-wordmark">F.</span>
            <h2 id="settings-title">Your stack, connected.</h2>
            <p>Each provider has a job. FOMO brings them together.</p>
            <Connections providers={status?.providers ?? {}} />
            <div className="settings-note">
              <b>Keys stay on the server.</b>
              <p>
                Configure providers in <code>.env.local</code> and restart FOMO. A “Ready” label
                means a key is configured; live results verify the connection.
              </p>
              <p>
                OpenRouter tries your configured models in order. Choosing a model moves it to the
                front of that list.
              </p>
            </div>
            <a href="https://github.com/NicholasDominici/bello" target="_blank" rel="noreferrer">
              Inspired by BELLO
              <ArrowUpRight size={13} />
            </a>
          </section>
        </div>
      )}
      {confirmDelete && (
        <div className="modal-backdrop" onClick={() => setConfirmDelete(false)}>
          <section
            ref={dialogRef}
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="icon-button modal-close"
              onClick={() => setConfirmDelete(false)}
              aria-label="Cancel deletion"
            >
              <X />
            </button>
            <h2 id="delete-title">Delete this conversation?</h2>
            <p>This removes its local messages, sources, and tool receipts. It cannot be undone.</p>
            <div className="confirmation-actions">
              <button onClick={() => setConfirmDelete(false)}>Keep conversation</button>
              <button
                className="primary"
                disabled={deleting}
                onClick={() => {
                  void remove().then(() => setConfirmDelete(false));
                }}
              >
                Delete conversation
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
const brandsList = { firecrawl: 1, orbit: 1, monid: 1, openrouter: 1 };
