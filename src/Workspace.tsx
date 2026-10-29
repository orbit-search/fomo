/** Evidence, live tool receipts, and source-backed people; no synthetic results. */
import { useState } from 'react';
import {
  ArrowUpRight,
  GlobeHemisphereWest,
  UsersThree,
  Wrench,
  Browser,
  Copy,
  Check,
} from '@phosphor-icons/react';
import type { Artifact, Provider } from '../shared/types';
import { orbitPersonSchema, orbitSourceUrl } from '../shared/orbit';
import Markdown from './Content';
export const brands: Record<
  Provider,
  { name: string; role: string; image: string; color: string }
> = {
  firecrawl: {
    name: 'Firecrawl',
    role: 'Browse the web',
    image: '/brands/firecrawl.png',
    color: '#ff6b32',
  },
  orbit: {
    name: 'Orbit',
    role: 'Instant agent onboarding',
    image: '/brands/orbit.png',
    color: '#92b6ff',
  },
  monid: { name: 'Monid', role: 'Put tools to work', image: '/brands/monid.png', color: '#9899ff' },
  openrouter: {
    name: 'OpenRouter',
    role: 'Find the right model',
    image: '/brands/openrouter.png',
    color: '#ccff00',
  },
};
export function Brand({ provider }: { provider: Provider }) {
  const b = brands[provider];
  return (
    <img className={`provider-image ${provider}`} src={b.image} width="28" height="28" alt="" />
  );
}
export function Connections({ providers }: { providers: Record<string, { configured: boolean }> }) {
  return (
    <div className="connections">
      {(Object.keys(brands) as Provider[]).map((p) => (
        <div className="connection" key={p}>
          <Brand provider={p} />
          <div>
            <b>{brands[p].name}</b>
            <span>{brands[p].role}</span>
          </div>
          <span className={`connection-status ${providers[p]?.configured ? 'connected' : ''}`}>
            {providers[p]?.configured ? 'Ready' : 'Needs key'}
          </span>
        </div>
      ))}
    </div>
  );
}
function JsonResult({ value }: { value: unknown }) {
  const [copied, setCopied] = useState(false);
  const text = JSON.stringify(value, null, 2);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="json-result">
      <button
        className="icon-button json-copy"
        onClick={() => void copy()}
        aria-label="Copy tool result"
      >
        {copied ? <Check /> : <Copy />}
      </button>
      <pre>{text}</pre>
    </div>
  );
}
function People({ artifact }: { artifact: Artifact }) {
  const rows = Array.isArray(artifact.data.people)
    ? artifact.data.people
    : artifact.data.person
      ? [artifact.data.person]
      : [];
  const people = rows.flatMap((x) => {
    const parsed = orbitPersonSchema.safeParse(x);
    return parsed.success ? [parsed.data] : [];
  });
  return (
    <div className="people-results">
      {people.map((p) => (
        <article className="person" key={p.profile_id}>
          <div className="person-top">
            <div className="initials">
              {p.name
                .split(' ')
                .slice(0, 2)
                .map((n) => n[0])
                .join('')}
            </div>
            <span className="receipt-state">{p.status}</span>
          </div>
          <h3>{p.name}</h3>
          {p.headline && <p className="person-headline">{p.headline}</p>}
          {p.location && <p className="muted location">{p.location}</p>}
          {p.bio && <p className="person-bio">{p.bio}</p>}
          <div className="person-links">
            {orbitSourceUrl(p.profile_url) && (
              <a href={orbitSourceUrl(p.profile_url)} target="_blank" rel="noreferrer">
                Orbit profile <ArrowUpRight />
              </a>
            )}
            <details>
              <summary>{p.sources.length} supporting sources</summary>
              {p.sources.map((s) => (
                <a key={s.url} href={orbitSourceUrl(s.url)} target="_blank" rel="noreferrer">
                  {s.title}
                  <ArrowUpRight />
                </a>
              ))}
            </details>
          </div>
        </article>
      ))}
      {!people.length && (
        <p className="muted">
          No profile results yet. The search status is {String(artifact.data.status ?? 'pending')}.
        </p>
      )}
    </div>
  );
}
function Evidence({ artifact }: { artifact: Artifact }) {
  const d = artifact.data;
  const url = orbitSourceUrl(d.url);
  const screenshot =
    typeof d.screenshot === 'string' &&
    (d.screenshot.startsWith('data:image/jpeg;base64,') || orbitSourceUrl(d.screenshot))
      ? d.screenshot
      : undefined;
  if (artifact.kind === 'people') return <People artifact={artifact} />;
  if (artifact.kind === 'tool')
    return (
      <>
        <div className="receipt-title">
          <Brand provider="monid" />
          <span>Run receipt</span>
          <b>{String(d.status ?? '')}</b>
        </div>
        {d.reason && <p>{String(d.reason)}</p>}
        <JsonResult value={d} />
      </>
    );
  return (
    <div className="page-evidence">
      <div className="page-address">
        <GlobeHemisphereWest size={15} />
        {url ? (
          <a href={url} target="_blank" rel="noreferrer">
            {new URL(url).hostname}
            <ArrowUpRight />
          </a>
        ) : (
          <span>Firecrawl browser</span>
        )}
      </div>
      {screenshot && (
        <a
          className="page-capture"
          href={url}
          target="_blank"
          rel="noreferrer"
          aria-label="Open captured page"
        >
          <img src={screenshot} alt={`Capture of ${artifact.title}`} referrerPolicy="no-referrer" />
        </a>
      )}
      <h3>{artifact.title}</h3>
      <details open={!screenshot}>
        <summary>Read page content</summary>
        <Markdown text={String(d.markdown ?? d.text ?? 'No text content returned.')} />
      </details>
      {Array.isArray(d.controls) && (
        <details>
          <summary>Observed controls</summary>
          <JsonResult value={d.controls} />
        </details>
      )}
    </div>
  );
}
export default function Workspace({
  artifacts,
  providers,
}: {
  artifacts: Artifact[];
  providers: Record<string, { configured: boolean }>;
}) {
  const [kind, setKind] = useState('all');
  const [selected, setSelected] = useState<string | null>(null);
  const visible =
    kind === 'all'
      ? artifacts
      : artifacts.filter((a) => a.kind === kind || (kind === 'page' && a.kind === 'browser'));
  const current = visible.find((a) => a.id === selected) ?? visible[0];
  const filteredEmpty = artifacts.length > 0 && kind !== 'all';
  const emptyLabel = kind === 'page' ? 'web pages' : kind === 'people' ? 'people' : 'tool results';
  return (
    <aside className="workspace" aria-label="Research workspace">
      <div className="workspace-heading">
        <span>Workspace</span>
        <span className="mono">
          {artifacts.length
            ? `${artifacts.length} ${artifacts.length === 1 ? 'artifact' : 'artifacts'}`
            : 'Ready for context'}
        </span>
      </div>
      <div className="workspace-tabs" role="tablist" aria-label="Evidence type">
        {[
          { id: 'all', text: 'All', icon: Browser },
          { id: 'page', text: 'Web', icon: GlobeHemisphereWest },
          { id: 'people', text: 'People', icon: UsersThree },
          { id: 'tool', text: 'Tools', icon: Wrench },
        ].map((t) => (
          <button
            key={t.id}
            role="tab"
            tabIndex={kind === t.id ? 0 : -1}
            aria-selected={kind === t.id}
            aria-controls="evidence-panel"
            id={`evidence-tab-${t.id}`}
            onClick={() => setKind(t.id)}
            onKeyDown={(event) => {
              const ids = ['all', 'page', 'people', 'tool'];
              const index = ids.indexOf(kind);
              const next =
                event.key === 'ArrowRight'
                  ? ids[(index + 1) % ids.length]
                  : event.key === 'ArrowLeft'
                    ? ids[(index + ids.length - 1) % ids.length]
                    : event.key === 'Home'
                      ? ids[0]
                      : event.key === 'End'
                        ? ids.at(-1)
                        : undefined;
              if (next) {
                event.preventDefault();
                setKind(next);
                document.getElementById(`evidence-tab-${next}`)?.focus();
              }
            }}
          >
            <t.icon size={16} />
            {t.text}
          </button>
        ))}
      </div>
      <div
        className="evidence-content"
        role="tabpanel"
        id="evidence-panel"
        aria-labelledby={`evidence-tab-${kind}`}
      >
        {current ? (
          <>
            {visible.length > 1 && (
              <label className="artifact-select">
                Artifact
                <select
                  aria-label="Choose artifact"
                  value={current.id}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  {visible.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <Evidence artifact={current} />
          </>
        ) : (
          <div className="workspace-empty">
            <div className="empty-stamp">
              <Browser weight="light" size={28} />
            </div>
            {filteredEmpty ? (
              <h2>No {emptyLabel} yet.</h2>
            ) : (
              <h2>
                The context behind
                <br />
                the conversation.
              </h2>
            )}
            <p>
              {filteredEmpty
                ? 'Results appear here when FOMO uses this part of your stack.'
                : 'Pages, people, and tool results land here as FOMO works.'}
            </p>
            <div className="stack-label">
              <span>Your connected stack</span>
            </div>
            <Connections providers={providers} />
          </div>
        )}
      </div>
      <footer className="workspace-footer">
        <span>Sources stay with the conversation.</span>
      </footer>
    </aside>
  );
}
