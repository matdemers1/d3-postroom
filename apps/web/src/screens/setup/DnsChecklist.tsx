import { StatusDot } from '@d3cloud/ui';
import type { DnsCheckRow } from '../../api';
import { CopyField } from './CopyField';
import { dnsStatus, showLive } from './wizard-dns';
import './wizard.css';

/**
 * DNS records as a list of small blocks, one per record, at every width (admin critique 2.9 #6): the
 * record and its type with its status as a dot and a word, the name and the expected value as
 * copyable read-only fields, what is live now when that differs, and why. It fits the 672 px page
 * and a 390 px phone without a sideways scroll, which the five-column DNS table cannot. A record
 * that already passes needs nothing more, so it is one line; `compact` makes every row one line, for
 * records this step does not ask for yet (the go-live ones).
 */
export function DnsChecklist({ rows, label, compact = false }: { rows: readonly DnsCheckRow[]; label: string; compact?: boolean }) {
  return (
    <ul className="pr-dnslist" aria-label={label}>
      {rows.map((r) => {
        const status = dnsStatus(r);
        const brief = compact || r.status === 'pass';
        return (
          <li key={`${r.record}:${r.name}`} className="pr-dnslist__item">
            <div className="pr-dnslist__head">
              <span className="pr-dnslist__title">
                {r.record} <span className="pr-dnslist__type">{r.type}</span>
              </span>
              <StatusDot size="sm" tone={status.tone}>
                {status.label}
              </StatusDot>
            </div>
            {brief ? null : (
              <>
                <CopyField label="Name" oneLine value={r.name} name={`${r.record} record name`} copyLabel={`${r.record} record name for ${r.name}`} />
                {r.expected === null ? (
                  <p className="pr-dnslist__note">{r.note ?? 'Not known yet'}</p>
                ) : (
                  <CopyField label="Value" value={r.expected} name={`Expected ${r.record} value`} copyLabel={`expected ${r.record} value for ${r.name}`} />
                )}
                {showLive(r) ? (
                  <div className="pr-dnslist__live">
                    <span className="pr-dnslist__live-label">Published now</span>
                    {r.live.map((v, i) => (
                      <code key={`${String(i)}:${v}`} className="pr-dnslist__value">
                        {v}
                      </code>
                    ))}
                  </div>
                ) : null}
              </>
            )}
            <p className="pr-dnslist__why">
              {brief ? (
                <>
                  <span className="pr-dnslist__value">{r.name}</span> ·{' '}
                </>
              ) : null}
              {r.reason}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
