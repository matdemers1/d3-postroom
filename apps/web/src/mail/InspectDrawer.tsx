// The Inspect drawer (PST-T-6.1, PST-REQ-114/115): everything Postroom knows about one message,
// with its reasons — "shows everything". The reading pane stays calm; the evidence lives here.
//
// Sections, in order: Authentication, Signature and encryption (PGP/S/MIME, PST-T-12.1 /
// PST-REQ-160), Received path (a timeline with a TLS badge per hop), Why this bucket, Spam score
// breakdown, Trackers removed, MDN request, Headers, Raw source. The data is one
// GET /api/messages/:id/inspect, fetched when the drawer opens; the raw source is fetched only when
// asked for, and only the first RAW_VIEW_CAP bytes are shown (the rest is a download).
//
// Learn mode (PST-REQ-115) links each header, reply code and verdict to the RFC section that defines
// it (./rfc-links.ts). They are plain links the reader opens; the app never fetches them. The toggle
// is remembered per account in localStorage — a viewer's convenience, not a setting.
//
// Opening: the "Inspect" button in the message actions, the `i` key, or the palette's "Inspect the
// open message" (both via keys.ts's requestInspect). It is a @d3cloud/ui Modal restyled as a side
// sheet (mail.css), so focus trap, Escape, aria-modal and focus return are the library's.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Badge, Button, Checkbox, Cluster, Modal, ModalClose, Skeleton, Stack } from '@d3cloud/ui';
import { api, type InspectAlignment, type InspectScore, type MessageInspect, type ReceivedHop } from '../api';
import { byteSize, fullDate } from './format';
import { cryptoView, type CryptoPartView } from './inspect-crypto';
import { describeTarget, onInspectRequest, resolveKey } from './keys';
import {
  headerRef,
  MDN_REF,
  readLearnMode,
  rfcUrl,
  smtpReplyRefs,
  TLS_PROTOCOL_REF,
  verdictRef,
  writeLearnMode,
  type RfcRef,
} from './rfc-links';

/** The raw source shown in the drawer is cut here; the full message is always a download. */
export const RAW_VIEW_CAP = 256 * 1024;

/** The section headings, in order — the e2e suite and the unit test hold the drawer to this list. */
export const INSPECT_SECTIONS = ['Authentication', 'Signature and encryption', 'Received path', 'Why this bucket', 'Spam score breakdown', 'Trackers removed', 'MDN request', 'Headers', 'Raw source'] as const;

type Tone = 'neutral' | 'attention' | 'danger';

/** How a verdict result reads at a glance. Only a failure is danger; anything short of a pass asks for attention. */
export function resultTone(result: string): Tone {
  const r = result.toLowerCase();
  if (r === 'pass') return 'neutral';
  if (r === 'fail' || r === 'permerror') return 'danger';
  if (r === 'none') return 'neutral';
  return 'attention';
}

export function delayText(seconds: number | null): string | null {
  if (seconds === null) return null;
  const sign = seconds < 0 ? '−' : '+';
  const s = Math.abs(seconds);
  if (s < 60) return `${sign}${String(s)} s`;
  if (s < 3600) return `${sign}${String(Math.round(s / 60))} min`;
  return `${sign}${String(Math.round(s / 360) / 10)} h`;
}

export function tlsLabel(tls: ReceivedHop['tls']): string {
  if (!tls.encrypted) return 'Not encrypted';
  return tls.version === null ? 'Encrypted' : `Encrypted · ${tls.version}`;
}

function RfcLink({ refTo, learn }: { refTo: RfcRef | null; learn: boolean }) {
  if (!learn || refTo === null) return null;
  return (
    <a className="pr-inspect__rfc" href={rfcUrl(refTo)} target="_blank" rel="noopener noreferrer" data-testid="rfc-link" title={refTo.title}>
      RFC {refTo.rfc} §{refTo.section}
      <span className="pr-vh">: {refTo.title} (opens rfc-editor.org)</span>
    </a>
  );
}

function Reasons({ reasons }: { reasons: readonly string[] }) {
  if (reasons.length === 0) return null;
  return (
    <ul className="pr-inspect__reasons">
      {reasons.map((r, i) => (
        <li key={`${String(i)}-${r}`}>{r}</li>
      ))}
    </ul>
  );
}

function Section({ title, children, extra }: { title: (typeof INSPECT_SECTIONS)[number]; children: ReactNode; extra?: ReactNode }) {
  const id = `pr-inspect-${title.toLowerCase().replace(/\s+/g, '-')}`;
  return (
    <section className="pr-inspect__section" aria-labelledby={id} data-testid="inspect-section" data-section={title}>
      <h3 id={id} className="pr-inspect__h3">
        {title}
        {extra}
      </h3>
      {children}
    </section>
  );
}

function alignmentText(a: InspectAlignment | null): string | null {
  if (a === null) return null;
  return a.aligned ? `aligned with the From domain${a.mode === null ? '' : ` (${a.mode})`}` : `not aligned with the From domain${a.mode === null ? '' : ` (${a.mode})`}`;
}

function Verdict({ label, result, learn, refTo, children }: { label: string; result: string; learn: boolean; refTo: RfcRef | null; children?: ReactNode }) {
  return (
    <div className="pr-inspect__verdict" data-testid="verdict" data-verdict={label}>
      <div className="pr-inspect__verdict-head">
        <span className="pr-inspect__term">{label}</span>
        <Badge tone={resultTone(result)}>{result}</Badge>
        <RfcLink refTo={refTo} learn={learn} />
      </div>
      {children}
    </div>
  );
}

function AuthSection({ auth, learn }: { auth: MessageInspect['auth']; learn: boolean }) {
  const nothing = auth.spf === null && auth.dkim.length === 0 && auth.dmarc === null && auth.arc === null && auth.dnsbl === null;
  return (
    <Section title="Authentication">
      {nothing ? (
        <p className="pr-reader__note">No authentication verdicts are stored for this message. Mail you sent, drafts and imports never passed through the inbound checks.</p>
      ) : (
        <Stack gap="12">
          {auth.spf !== null ? (
            <Verdict label="SPF" result={auth.spf.result} learn={learn} refTo={verdictRef('spf', auth.spf.result)}>
              <p className="pr-inspect__evidence">
                {auth.spf.domain === null ? 'No domain' : <>Domain <code>{auth.spf.domain}</code></>}
                {auth.spf.mechanism === null ? null : <> · matched <code>{auth.spf.mechanism}</code></>}
                {alignmentText(auth.spf.alignment) === null ? null : <> · {alignmentText(auth.spf.alignment)}</>}
                {auth.spf.alignment === null ? null : <RfcLink refTo={verdictRef('alignment')} learn={learn} />}
              </p>
              <Reasons reasons={auth.spf.reasons} />
            </Verdict>
          ) : null}
          {auth.dkim.length === 0 ? (
            <Verdict label="DKIM" result="none" learn={learn} refTo={verdictRef('dkim')}>
              <p className="pr-inspect__evidence">The message carries no DKIM signature.</p>
            </Verdict>
          ) : (
            auth.dkim.map((d, i) => (
              <Verdict key={`${String(i)}-${d.domain ?? ''}`} label={auth.dkim.length === 1 ? 'DKIM' : `DKIM ${String(i + 1)}`} result={d.result} learn={learn} refTo={verdictRef('dkim')}>
                <p className="pr-inspect__evidence">
                  {d.domain === null ? 'No d=' : <>d=<code>{d.domain}</code></>}
                  {d.selector === null ? null : <> · s=<code>{d.selector}</code></>}
                  {d.algorithm === null ? null : <> · {d.algorithm}</>}
                  {d.testing ? ' · testing key (t=y)' : null}
                  {alignmentText(d.alignment) === null ? null : <> · {alignmentText(d.alignment)}</>}
                  <RfcLink refTo={headerRef('DKIM-Signature')} learn={learn} />
                </p>
                <Reasons reasons={d.reasons} />
              </Verdict>
            ))
          )}
          {auth.dmarc !== null ? (
            <Verdict label="DMARC" result={auth.dmarc.result} learn={learn} refTo={verdictRef('dmarc')}>
              <p className="pr-inspect__evidence">
                {auth.dmarc.fromDomain === null ? 'No single From domain' : <>From domain <code>{auth.dmarc.fromDomain}</code></>}
                {auth.dmarc.policy === null ? null : <> · policy <code>{auth.dmarc.policy}</code>{auth.dmarc.policySource === null ? null : ` (${auth.dmarc.policySource}=)`}</>}
                {auth.dmarc.disposition === null ? null : <> · disposition {auth.dmarc.disposition}</>}
                {auth.dmarc.policy === null ? null : <RfcLink refTo={verdictRef('dmarc-policy')} learn={learn} />}
              </p>
              <Reasons reasons={auth.dmarc.reasons} />
            </Verdict>
          ) : null}
          {auth.arc !== null ? (
            <Verdict label="ARC" result={auth.arc.result} learn={learn} refTo={verdictRef('arc', auth.arc.result)}>
              <p className="pr-inspect__evidence">
                {auth.arc.instances === null ? null : <>{String(auth.arc.instances)} ARC set{auth.arc.instances === 1 ? '' : 's'}</>}
                {auth.arc.sealerDomains.length === 0 ? null : <> · sealed by {auth.arc.sealerDomains.join(', ')}</>}
              </p>
              <Reasons reasons={auth.arc.reasons} />
              {auth.arcOverride === null ? null : (
                <>
                  <p className="pr-inspect__evidence">A trusted ARC sealer overrode a DMARC failure:</p>
                  <Reasons reasons={auth.arcOverride} />
                </>
              )}
            </Verdict>
          ) : null}
          {auth.dnsbl !== null ? (
            <Verdict label="DNSBL" result={auth.dnsbl.listed ? 'listed' : 'not listed'} learn={learn} refTo={verdictRef('dnsbl')}>
              <p className="pr-inspect__evidence">
                {auth.dnsbl.zone === null ? 'Blocklist' : <>Zone <code>{auth.dnsbl.zone}</code></>}
                {auth.dnsbl.reason === null ? null : <> · {auth.dnsbl.reason}</>}
              </p>
            </Verdict>
          ) : null}
        </Stack>
      )}
      {auth.authenticationResults.length > 0 ? (
        <div className="pr-inspect__ar">
          <p className="pr-inspect__evidence">
            Authentication-Results in the message <RfcLink refTo={headerRef('Authentication-Results')} learn={learn} />
          </p>
          <ul className="pr-inspect__code-list">
            {auth.authenticationResults.map((v, i) => (
              <li key={`${String(i)}-${v}`}>
                <code>{v}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Section>
  );
}

function CryptoPart({ label, part }: { label: string; part: CryptoPartView }) {
  return (
    <div className="pr-inspect__verdict" data-testid="crypto-part" data-crypto={label} data-status={part.status}>
      <div className="pr-inspect__verdict-head">
        <span className="pr-inspect__term">{label}</span>
        <Badge tone={part.tone}>{part.status}</Badge>
      </div>
      <p className="pr-inspect__evidence">{part.headline}</p>
      {part.facts.length === 0 ? null : (
        <ul className="pr-inspect__reasons">
          {part.facts.map((f, i) => (
            <li key={`${String(i)}-${f.label}`}>
              {f.label}: <code>{f.value}</code>
            </li>
          ))}
        </ul>
      )}
      <Reasons reasons={part.reasons} />
    </div>
  );
}

function CryptoSection({ crypto }: { crypto: MessageInspect['crypto'] }) {
  const view = cryptoView(crypto);
  return (
    <Section title="Signature and encryption">
      <Stack gap="12">
        <CryptoPart label="Signature" part={view.signature} />
        {view.certificates.length === 0 ? null : (
          <div data-testid="crypto-chain">
            <p className="pr-inspect__evidence">Certificate chain, as the message presented it:</p>
            <ol className="pr-inspect__reasons">
              {view.certificates.map((c, i) => (
                <li key={`${String(i)}-${c.subject}`}>
                  <code>{c.subject}</code> — issued by <code>{c.issuer}</code> · {c.detail}
                </li>
              ))}
            </ol>
            {view.chainNote === null ? null : <p className="pr-inspect__evidence">{view.chainNote}</p>}
          </div>
        )}
        <CryptoPart label="Encryption" part={view.encryption} />
      </Stack>
    </Section>
  );
}

function ReplyWithLinks({ reply, learn }: { reply: string; learn: boolean }) {
  const refs = smtpReplyRefs(reply);
  return (
    <>
      <code>{reply}</code>
      {refs.code === null ? null : <RfcLink refTo={refs.code} learn={learn} />}
      {refs.enhanced === null ? null : <RfcLink refTo={refs.enhanced} learn={learn} />}
    </>
  );
}

function ReceivedSection({ data, learn }: { data: MessageInspect; learn: boolean }) {
  const { received, receipt } = data;
  return (
    <Section title="Received path" extra={<RfcLink refTo={headerRef('Received')} learn={learn} />}>
      {received.length === 0 ? (
        <p className="pr-reader__note">The message has no Received headers: it never travelled over SMTP.</p>
      ) : (
        <ol className="pr-inspect__hops" aria-label="Hops, oldest first">
          {received.map((hop, i) => {
            const delay = delayText(hop.delaySeconds);
            return (
              <li key={`${String(i)}-${hop.raw}`} className="pr-inspect__hop" data-testid="received-hop">
                <div className="pr-inspect__verdict-head">
                  <span className="pr-inspect__term">{hop.by ?? '(unnamed host)'}</span>
                  <Badge tone={hop.tls.encrypted ? 'neutral' : 'attention'} data-testid="tls-badge">
                    {tlsLabel(hop.tls)}
                  </Badge>
                  {hop.ours ? <Badge tone="neutral">This server</Badge> : null}
                  {hop.tls.encrypted ? <RfcLink refTo={TLS_PROTOCOL_REF} learn={learn} /> : null}
                </div>
                <p className="pr-inspect__evidence">
                  from {hop.from ?? 'unknown'}
                  {hop.fromRdns !== null && hop.fromRdns !== hop.from ? ` (${hop.fromRdns})` : ''}
                  {hop.fromIp === null ? '' : ` [${hop.fromIp}]`}
                  {hop.with === null ? '' : ` · with ${hop.with}`}
                  {hop.tls.cipher === null ? '' : ` · ${hop.tls.cipher}`}
                </p>
                <p className="pr-reader__note">
                  {hop.timestamp === null ? 'No readable date' : <time dateTime={hop.timestamp}>{fullDate(hop.timestamp)}</time>}
                  {delay === null ? null : ` · ${delay} after the previous hop`}
                </p>
              </li>
            );
          })}
        </ol>
      )}
      {receipt === null ? null : (
        <dl className="pr-inspect__dl" aria-label="How it reached this server">
          <dt>Client</dt>
          <dd>
            {receipt.clientIp ?? 'unknown'}
            {receipt.rdns === null ? '' : ` (${receipt.rdns})`}
            {receipt.proxied ? ' · through the edge' : ''}
          </dd>
          <dt>HELO</dt>
          <dd>{receipt.helo ?? '(none)'}</dd>
          <dt>TLS</dt>
          <dd>{receipt.tls ?? 'Not encrypted'}</dd>
          <dt>Envelope from</dt>
          <dd>{receipt.envelopeFrom === '' ? '<> (a bounce)' : receipt.envelopeFrom}</dd>
          <dt>Accepted</dt>
          <dd>
            <time dateTime={receipt.receivedAt}>{fullDate(receipt.receivedAt)}</time> · {receipt.disposition}
            {receipt.dispositionReason === null ? '' : ` (${receipt.dispositionReason})`}
          </dd>
          {receipt.smtpReply === null ? null : (
            <>
              <dt>Reply sent</dt>
              <dd>
                <ReplyWithLinks reply={receipt.smtpReply} learn={learn} />
              </dd>
            </>
          )}
        </dl>
      )}
    </Section>
  );
}

function ScoreTable({ caption, rows, testId }: { caption: string; rows: readonly InspectScore[]; testId: string }) {
  return (
    <table className="pr-inspect__table" data-testid={testId}>
      <caption className="pr-vh">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Score</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((s) => (
          <tr key={s.name}>
            <td>
              <code>{s.name}</code>
            </td>
            <td className="pr-inspect__score">
              <span className="pr-inspect__num">{Number.isInteger(s.value) ? String(s.value) : s.value.toFixed(2)}</span>
              <span className="pr-inspect__bar" aria-hidden="true">
                <span className="pr-inspect__bar-fill" style={{ inlineSize: `${String(Math.round(Math.min(1, Math.max(0, s.value)) * 100))}%` }} />
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BucketSection({ bucket }: { bucket: MessageInspect['bucket'] }) {
  return (
    <Section title="Why this bucket">
      {bucket === null ? (
        <p className="pr-reader__note">No sorting decision is stored for this message: it was not sorted on arrival (your own mail, a draft or an import).</p>
      ) : (
        <Stack gap="8">
          <p className="pr-inspect__evidence">
            Filed as <strong>{bucket.bucket ?? 'no bucket'}</strong>, for these reasons:
          </p>
          <Reasons reasons={bucket.reasons} />
          {bucket.scores.length === 0 ? null : <ScoreTable caption="Scores behind the decision" rows={bucket.scores} testId="bucket-scores" />}
        </Stack>
      )}
    </Section>
  );
}

function SpamSection({ spam }: { spam: MessageInspect['spam'] }) {
  const empty = spam.signals.length === 0 && spam.bayes === null && spam.attachments.length === 0;
  return (
    <Section title="Spam score breakdown">
      {empty ? (
        <p className="pr-reader__note">No classifier scores are stored for this message.</p>
      ) : (
        <Stack gap="12">
          {spam.signals.length === 0 ? null : <ScoreTable caption="Rule signals" rows={spam.signals} testId="spam-signals" />}
          {spam.bayes === null ? null : (
            <div>
              <p className="pr-inspect__evidence">
                Bayes{spam.bayes.trainingDocs === null ? '' : `, trained on ${String(spam.bayes.trainingDocs)} messages`}
                {spam.bayes.topTokens.length === 0 ? '' : '; the words that decided it:'}
              </p>
              {spam.bayes.topTokens.length === 0 ? null : (
                <ul className="pr-inspect__tokens" aria-label="Top Bayes tokens">
                  {spam.bayes.topTokens.map((t) => (
                    <li key={t}>
                      <code>{t}</code>
                    </li>
                  ))}
                </ul>
              )}
              {spam.bayes.probabilities.length === 0 ? null : (
                <ScoreTable caption="Bayes probability per bucket" rows={spam.bayes.probabilities.map((p) => ({ name: p.bucket, value: p.probability }))} testId="bayes-probabilities" />
              )}
            </div>
          )}
          {spam.attachments.length === 0 ? null : (
            <div>
              <p className="pr-inspect__evidence">Attachment policy</p>
              <ul className="pr-inspect__reasons">
                {spam.attachments.map((a) => (
                  <li key={a.partId}>
                    {a.filename ?? `Part ${a.partId}`}: {a.verdict}
                    {a.kind === null ? '' : ` (${a.kind})`}
                    {a.reasons.length === 0 ? '' : ` — ${a.reasons.join('; ')}`}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Stack>
      )}
    </Section>
  );
}

function TrackersSection({ trackers }: { trackers: MessageInspect['trackers'] }) {
  return (
    <Section title="Trackers removed">
      {!trackers.html ? (
        <p className="pr-reader__note">Plain text only: there was nothing that could track you.</p>
      ) : (
        <ul className="pr-inspect__reasons" data-testid="trackers">
          <li>
            {trackers.trackersBlocked === 1 ? '1 tracking pixel' : `${String(trackers.trackersBlocked)} tracking pixels`} removed, never loaded.
          </li>
          <li>{trackers.linksCleaned === 1 ? '1 link' : `${String(trackers.linksCleaned)} links`} cleaned of tracking parameters or redirect wrappers.</li>
          <li>{trackers.remoteImages === 1 ? '1 remote image' : `${String(trackers.remoteImages)} remote images`}, blocked until you load them through the proxy.</li>
        </ul>
      )}
    </Section>
  );
}

function MdnSection({ mdn, learn }: { mdn: MessageInspect['mdn']; learn: boolean }) {
  return (
    <Section title="MDN request" extra={<RfcLink refTo={MDN_REF} learn={learn} />}>
      {!mdn.requested ? (
        <p className="pr-reader__note">The sender did not ask for a read receipt.</p>
      ) : (
        <Stack gap="4">
          <p className="pr-inspect__evidence" data-testid="mdn-request">
            The sender asked for a read receipt to <code>{mdn.to.length === 0 ? (mdn.header ?? '') : mdn.to.join(', ')}</code>.
          </p>
          {mdn.returnPathMatches === false ? (
            <p className="pr-inspect__evidence">That address is not the message&apos;s Return-Path, so a receipt would need your explicit say-so.</p>
          ) : null}
          <p className="pr-reader__note">No receipt has been sent. Postroom never sends one on its own.</p>
        </Stack>
      )}
    </Section>
  );
}

function HeadersSection({ headers, learn }: { headers: MessageInspect['headers']; learn: boolean }) {
  return (
    <Section title="Headers">
      <div className="pr-inspect__scroll" tabIndex={0} role="region" aria-label="Header fields">
        <table className="pr-inspect__table pr-inspect__headers">
          <caption className="pr-vh">Every header field, in order</caption>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            {headers.map((h, i) => (
              <tr key={`${String(i)}-${h.name}`}>
                <th scope="row">
                  {h.name}
                  <RfcLink refTo={headerRef(h.name)} learn={learn} />
                </th>
                <td>{h.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

type RawState = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; text: string; truncated: boolean } | { status: 'error' };

/** Reads at most `cap` bytes of a response body, then stops the download. */
async function readCapped(res: Response, cap: number): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (reader === undefined) {
    const text = await res.text();
    return { text: text.slice(0, cap), truncated: text.length > cap };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total >= cap) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  const all = new Uint8Array(Math.min(total, cap));
  let at = 0;
  for (const c of chunks) {
    const room = all.length - at;
    if (room <= 0) break;
    all.set(c.subarray(0, room), at);
    at += Math.min(room, c.byteLength);
  }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(all), truncated };
}

function RawSection({ raw }: { raw: MessageInspect['raw'] }) {
  const [state, setState] = useState<RawState>({ status: 'idle' });
  const [copied, setCopied] = useState(false);
  const load = () => {
    setState({ status: 'loading' });
    fetch(raw.url, { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const { text, truncated } = await readCapped(res, RAW_VIEW_CAP);
        setState({ status: 'ready', text, truncated });
      })
      .catch(() => {
        setState({ status: 'error' });
      });
  };
  const copy = () => {
    if (state.status !== 'ready') return;
    navigator.clipboard.writeText(state.text).then(
      () => {
        setCopied(true);
      },
      () => {
        setCopied(false);
      },
    );
  };
  return (
    <Section title="Raw source">
      <Stack gap="8">
        <Cluster gap="8">
          {state.status === 'ready' ? (
            <Button size="sm" variant="secondary" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          ) : (
            <Button size="sm" variant="secondary" loading={state.status === 'loading'} onClick={load}>
              Show raw source
            </Button>
          )}
          <a className="pr-inspect__download" href={raw.url} download>
            Download raw ({byteSize(raw.size)})
          </a>
        </Cluster>
        {state.status === 'error' ? (
          <Alert tone="warning" title="The raw source could not be loaded">
            Postroom did not answer. The download link may still work.
          </Alert>
        ) : null}
        {state.status === 'ready' ? (
          <>
            <pre className="pr-inspect__raw" tabIndex={0} aria-label="Raw source" data-testid="raw-source">
              {state.text}
            </pre>
            {state.truncated ? <p className="pr-reader__note">Only the first {byteSize(RAW_VIEW_CAP)} are shown here. Download it for the whole message.</p> : null}
          </>
        ) : null}
      </Stack>
    </Section>
  );
}

/** Every section, for one message's evidence. Pure rendering: the unit test renders it to a string. */
export function InspectSections({ data, learn }: { data: MessageInspect; learn: boolean }) {
  return (
    <div className="pr-inspect__body" data-testid="inspect-body">
      <AuthSection auth={data.auth} learn={learn} />
      <CryptoSection crypto={data.crypto} />
      <ReceivedSection data={data} learn={learn} />
      <BucketSection bucket={data.bucket} />
      <SpamSection spam={data.spam} />
      <TrackersSection trackers={data.trackers} />
      <MdnSection mdn={data.mdn} learn={learn} />
      <HeadersSection headers={data.headers} learn={learn} />
      <RawSection key={data.id} raw={data.raw} />
    </div>
  );
}

type LoadState = { status: 'loading' } | { status: 'ready'; data: MessageInspect } | { status: 'error' };

/** The Inspect button (for the message actions) and the drawer it opens. */
export function InspectDrawer({ messageId }: { messageId: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [learn, setLearn] = useState(false);
  const pending = useRef<'g' | null>(null);

  // The palette's command and the `i` key both arrive here.
  useEffect(() => onInspectRequest(() => { setOpen(true); }), []);
  useEffect(() => {
    // MailView resolves `i` too, but has nothing to do with it; the drawer of the open message does.
    // Mirrors MailView's rules: its own g-sequence state, nothing while typing, nothing behind a dialog.
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const { action, pending: next } = resolveKey({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, ...describeTarget(e.target) }, pending.current);
      pending.current = next;
      if (action !== 'inspect') return;
      const el = e.target instanceof Element ? e.target : null;
      if ((el?.closest('[role="dialog"], [role="alertdialog"], [role="menu"]') ?? null) !== null) return;
      e.preventDefault();
      setOpen(true);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  // A different message closes the drawer and forgets the last one's evidence.
  useEffect(() => {
    setOpen(false);
    setState({ status: 'loading' });
  }, [messageId]);

  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    setState({ status: 'loading' });
    api.inspectMessage(messageId).then(
      (data) => {
        if (live) setState({ status: 'ready', data });
      },
      () => {
        if (live) setState({ status: 'error' });
      },
    );
    return () => {
      live = false;
    };
  }, [open, messageId, attempt]);

  useEffect(() => {
    if (!open || accountId !== null) return;
    api.state().then(
      (s) => {
        const id = s.account?.id ?? null;
        setAccountId(id);
        if (id !== null) setLearn(readLearnMode(id));
      },
      () => undefined,
    );
  }, [open, accountId]);

  const toggleLearn = useCallback(
    (on: boolean) => {
      setLearn(on);
      if (accountId !== null) writeLearnMode(accountId, on);
    },
    [accountId],
  );

  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button size="sm" variant="ghost" aria-keyshortcuts="i">
          Inspect
        </Button>
      }
      title="Inspect message"
      description="Everything Postroom knows about this message, and why it decided what it did."
      size="lg"
      className="pr-inspect"
      footer={
        <ModalClose>
          <Button type="button">Close</Button>
        </ModalClose>
      }
    >
      <Stack gap="16">
        <Checkbox
          label="Learn mode: link each header, reply code and verdict to the RFC that defines it"
          checked={learn}
          onCheckedChange={(c) => {
            toggleLearn(c === true);
          }}
        />
        {state.status === 'loading' ? (
          <Stack gap="12" aria-busy="true">
            <Skeleton variant="text" lines={4} />
            <Skeleton variant="block" height={120} />
          </Stack>
        ) : state.status === 'error' ? (
          <Alert tone="warning" title="The evidence could not be loaded" actions={<Button size="sm" onClick={() => { setAttempt((n) => n + 1); }}>Try again</Button>}>
            Postroom did not answer. Check your connection.
          </Alert>
        ) : (
          <InspectSections data={state.data} learn={learn} />
        )}
      </Stack>
    </Modal>
  );
}
