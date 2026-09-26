import './calendar.css';
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Button, Cluster, EmptyState, IconButton, Page, PageHeader, SegmentedControl } from '@d3cloud/ui';
import { calendarApi, type Calendar as CalendarJson, type EventInstance } from '../api';
import { useMediaQuery } from '../mail/useMedia';
import { EventEditor, type EditorTarget } from './EventEditor';
import {
  addDays,
  dayLabel,
  instancesOnDay,
  layoutTimed,
  MINUTES_PER_DAY,
  monthGrid,
  rangeOf,
  sameMonth,
  step,
  timeLabel,
  today,
  viewHeading,
  VIEWS,
  visibleDays,
  type View,
} from './layout';
import { Loading, LoadFailed } from '../screens/states';

/** Below this the grid is an agenda list (PST-REQ-136's 390 px phone layout). */
const GRID_QUERY = '(min-width: 640px)';
const HOUR_PX = 48;
const MONTH_CELL_MAX = 3;
const VIEW_LABEL: Record<View, string> = { month: 'Month', week: 'Week', day: 'Day' };
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function viewerZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function ChevronIcon({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d={dir === 'left' ? 'm15 6-6 6 6 6' : 'm9 6 6 6-6 6'} />
    </svg>
  );
}

function eventLabel(i: EventInstance, tz: string): string {
  const when = i.allDay ? 'All day' : `${timeLabel(i.start, tz)} to ${timeLabel(i.end, tz)}`;
  return `${i.summary === '' ? 'Untitled event' : i.summary}, ${when}${i.location === '' ? '' : `, ${i.location}`}${i.recurring ? ', repeats' : ''}`;
}

function EventChip({ instance, tz, compact, onOpen }: { instance: EventInstance; tz: string; compact: boolean; onOpen: (i: EventInstance) => void }) {
  return (
    <button
      type="button"
      className="pr-cal-chip"
      data-all-day={instance.allDay ? 'true' : undefined}
      aria-label={eventLabel(instance, tz)}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(instance);
      }}
    >
      {instance.allDay || compact ? null : <span className="pr-cal-chip__time">{timeLabel(instance.start, tz)}</span>}
      <span className="pr-cal-chip__title">{instance.summary === '' ? 'Untitled event' : instance.summary}</span>
    </button>
  );
}

/**
 * The calendar (PST-T-8.5, PST-REQ-136): month, week and day views of every calendar the account
 * syncs over CalDAV, recurrences expanded by the server; below 640 px an agenda list. Keyboard:
 * arrows move between days in the month grid, Enter opens a day; j/k next/previous, t today,
 * m/w/d switch view, n new event.
 */
export function Calendar() {
  const tz = useMemo(viewerZone, []);
  const [params, setParams] = useSearchParams();
  const grid = useMediaQuery(GRID_QUERY);
  const rawView = params.get('view');
  const view: View = rawView === 'week' || rawView === 'day' ? rawView : 'month';
  const rawDay = params.get('date') ?? '';
  const anchor = DAY_RE.test(rawDay) ? rawDay : today(tz);

  const [calendars, setCalendars] = useState<CalendarJson[] | null>(null);
  const [instances, setInstances] = useState<EventInstance[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [focusDay, setFocusDay] = useState(anchor);
  const gridRef = useRef<HTMLTableElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Set by an arrow key in the month grid: the day it moved to takes focus once it is rendered. */
  const moveFocus = useRef(false);

  const days = useMemo(() => visibleDays(view, anchor), [view, anchor]);
  const range = useMemo(() => rangeOf(days, tz), [days, tz]);

  const navigate = useCallback(
    (next: { view?: View; date?: string }) => {
      const p = new URLSearchParams(params);
      p.set('view', next.view ?? view);
      p.set('date', next.date ?? anchor);
      setParams(p, { replace: false });
    },
    [params, setParams, view, anchor],
  );

  const load = useCallback(async () => {
    try {
      const [cals, list] = await Promise.all([calendarApi.calendars(), calendarApi.events({ start: range.start, end: range.end, tz })]);
      setCalendars(cals.calendars);
      setInstances(list.instances);
      setTruncated(list.truncated);
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught);
    }
  }, [range, tz]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setFocusDay(anchor);
  }, [anchor]);

  // The time grid opens at 8 AM rather than midnight.
  useEffect(() => {
    if (scrollRef.current !== null) scrollRef.current.scrollTop = 8 * HOUR_PX;
  }, [view, grid]);

  const openNew = (day: string, minutes: number | null = null) => {
    setNotice(null);
    setEditor({ kind: 'new', day, minutes });
  };
  const openEdit = (instance: EventInstance) => {
    setNotice(null);
    setEditor({ kind: 'edit', instance });
  };

  // Page shortcuts, only when nothing else has focus that types or a dialog is open.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (editor !== null || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t !== null && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.closest('[role="dialog"]') !== null)) return;
      const key = e.key;
      if (key === 'j') navigate({ date: step(view, anchor, 1) });
      else if (key === 'k') navigate({ date: step(view, anchor, -1) });
      else if (key === 't') navigate({ date: today(tz) });
      else if (key === 'm') navigate({ view: 'month' });
      else if (key === 'w') navigate({ view: 'week' });
      else if (key === 'd') navigate({ view: 'day' });
      else if (key === 'n') openNew(view === 'month' ? focusDay : anchor);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [editor, navigate, view, anchor, tz, focusDay]);

  // Month grid: arrows move the focused day (crossing into the next month moves the view).
  const onGridKey = (e: KeyboardEvent<HTMLTableElement>) => {
    const delta = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' ? -7 : e.key === 'ArrowDown' ? 7 : e.key === 'Home' ? -((new Date(`${focusDay}T12:00:00Z`).getUTCDay() + 7) % 7) : 0;
    if (delta === 0) {
      if (e.key === 'PageUp' || e.key === 'PageDown') {
        e.preventDefault();
        moveFocus.current = true;
        navigate({ date: step('month', focusDay, e.key === 'PageUp' ? -1 : 1) });
      }
      return;
    }
    e.preventDefault();
    const next = addDays(focusDay, delta);
    moveFocus.current = true;
    setFocusDay(next);
    if (!sameMonth(next, anchor)) navigate({ date: next });
  };

  useEffect(() => {
    const table = gridRef.current;
    if (table === null || !moveFocus.current) return;
    const target = table.querySelector<HTMLButtonElement>(`[data-day="${focusDay}"]`);
    if (target === null) return;
    moveFocus.current = false;
    target.focus();
  }, [focusDay, instances, anchor]);

  const heading = viewHeading(view, anchor);
  const todayDay = today(tz);
  const list = instances ?? [];

  const toolbar = (
    <div className="pr-cal-toolbar">
      <Cluster gap="8" align="center">
        <Button
          type="button"
          size="sm"
          onClick={() => {
            navigate({ date: todayDay });
          }}
        >
          Today
        </Button>
        <IconButton
          icon={<ChevronIcon dir="left" />}
          label={`Previous ${view}`}
          size="sm"
          onClick={() => {
            navigate({ date: step(view, anchor, -1) });
          }}
        />
        <IconButton
          icon={<ChevronIcon dir="right" />}
          label={`Next ${view}`}
          size="sm"
          onClick={() => {
            navigate({ date: step(view, anchor, 1) });
          }}
        />
        <h2 className="pr-cal-heading" aria-live="polite">
          {heading}
        </h2>
      </Cluster>
      <SegmentedControl
        aria-label="View"
        size="sm"
        items={VIEWS.map((v) => ({ value: v, label: VIEW_LABEL[v] }))}
        value={view}
        onValueChange={(v) => {
          navigate({ view: v as View });
        }}
      />
    </div>
  );

  let body;
  if (loadError !== null) {
    body = <LoadFailed error={loadError} what="the calendar" onRetry={() => void load()} />;
  } else if (instances === null) {
    body = <Loading label="Loading the calendar" height={320} />;
  } else if (!grid) {
    body = <Agenda days={days} instances={list} tz={tz} todayDay={todayDay} onOpen={openEdit} onNew={openNew} />;
  } else if (view === 'month') {
    body = (
      <table className="pr-cal-month" ref={gridRef} onKeyDown={onGridKey}>
        <caption className="pr-cal-vh">{heading}. Use the arrow keys to move between days and Enter to open one.</caption>
        <thead>
          <tr>
            {(monthGrid(anchor)[0] ?? []).map((d) => (
              <th key={d} scope="col">
                <abbr title={new Intl.DateTimeFormat(undefined, { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`))}>
                  {new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`))}
                </abbr>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {monthGrid(anchor).map((week) => (
            <tr key={week[0]}>
              {week.map((d) => {
                const on = instancesOnDay(list, d, tz);
                const all = [...on.allDay, ...on.timed];
                const more = all.length - MONTH_CELL_MAX;
                return (
                  <td
                    key={d}
                    data-outside={sameMonth(d, anchor) ? undefined : 'true'}
                    data-today={d === todayDay ? 'true' : undefined}
                    onDoubleClick={() => {
                      openNew(d);
                    }}
                  >
                    <button
                      type="button"
                      className="pr-cal-daynum"
                      data-day={d}
                      tabIndex={d === focusDay ? 0 : -1}
                      aria-label={`${dayLabel(d)}${d === todayDay ? ', today' : ''}, ${String(all.length)} ${all.length === 1 ? 'event' : 'events'}`}
                      aria-current={d === todayDay ? 'date' : undefined}
                      onFocus={() => {
                        setFocusDay(d);
                      }}
                      onClick={() => {
                        navigate({ view: 'day', date: d });
                      }}
                    >
                      {Number(d.slice(8, 10))}
                    </button>
                    <ul className="pr-cal-daylist">
                      {all.slice(0, more > 0 ? MONTH_CELL_MAX - 1 : MONTH_CELL_MAX).map((i) => (
                        <li key={`${i.calendarId}/${i.name}/${i.recurrenceId}`}>
                          <EventChip instance={i} tz={tz} compact={false} onOpen={openEdit} />
                        </li>
                      ))}
                      {more > 0 ? (
                        <li>
                          <button
                            type="button"
                            className="pr-cal-more"
                            onClick={() => {
                              navigate({ view: 'day', date: d });
                            }}
                          >
                            {more + 1} more
                          </button>
                        </li>
                      ) : null}
                    </ul>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    );
  } else {
    body = (
      <TimeGrid
        days={days}
        instances={list}
        tz={tz}
        todayDay={todayDay}
        scrollRef={scrollRef}
        onOpen={openEdit}
        onNew={openNew}
        onDay={(d) => {
          navigate({ view: 'day', date: d });
        }}
      />
    );
  }

  return (
    <Page width="wide">
      <PageHeader
        title="Calendar"
        actions={
          <Button
            variant="primary"
            onClick={() => {
              openNew(view === 'month' ? focusDay : anchor);
            }}
          >
            New event
          </Button>
        }
      />
      {notice === null ? null : (
        <Alert tone="success" dynamic>
          {notice}
        </Alert>
      )}
      {truncated ? (
        <Alert tone="warning" title="Not every event is shown">
          This range holds more events than the calendar lists at once.
        </Alert>
      ) : null}
      <section className="pr-cal" aria-label="Calendar">
        {toolbar}
        {grid && loadError === null && instances !== null && list.length === 0 ? (
          <EmptyState kind="empty" heading="Nothing scheduled" headingLevel={2} size="row">
            No events this {view}.
          </EmptyState>
        ) : null}
        {body}
      </section>
      <EventEditor
        target={editor}
        calendars={calendars ?? []}
        tz={tz}
        onClose={() => {
          setEditor(null);
        }}
        onChanged={(message) => {
          setEditor(null);
          setNotice(message);
          void load();
        }}
      />
    </Page>
  );
}

function TimeGrid({
  days,
  instances,
  tz,
  todayDay,
  scrollRef,
  onOpen,
  onNew,
  onDay,
}: {
  days: string[];
  instances: EventInstance[];
  tz: string;
  todayDay: string;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onOpen: (i: EventInstance) => void;
  onNew: (day: string, minutes: number | null) => void;
  onDay: (day: string) => void;
}) {
  const perDay = days.map((d) => ({ day: d, ...instancesOnDay(instances, d, tz) }));
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const hourLabel = (h: number): string => new Intl.DateTimeFormat(undefined, { hour: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 0, 1, h)));
  return (
    <div className="pr-cal-week" style={{ '--pr-cal-days': String(days.length) } as React.CSSProperties}>
      <div className="pr-cal-week__row pr-cal-week__head">
        <div className="pr-cal-week__gutter" />
        {perDay.map(({ day }) => (
          <div key={day} className="pr-cal-week__dayhead" data-today={day === todayDay ? 'true' : undefined}>
            <button
              type="button"
              className="pr-cal-week__daybtn"
              aria-current={day === todayDay ? 'date' : undefined}
              aria-label={`${dayLabel(day)}${day === todayDay ? ', today' : ''}`}
              onClick={() => {
                onDay(day);
              }}
            >
              <span className="pr-cal-week__dow">{new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`))}</span>
              <span className="pr-cal-week__dom">{Number(day.slice(8, 10))}</span>
            </button>
          </div>
        ))}
      </div>
      <div className="pr-cal-week__row pr-cal-week__allday">
        <div className="pr-cal-week__gutter">All day</div>
        {perDay.map(({ day, allDay }) => (
          <ul key={day} className="pr-cal-daylist" aria-label={`All-day events, ${dayLabel(day)}`}>
            {allDay.map((i) => (
              <li key={`${i.calendarId}/${i.name}/${i.recurrenceId}`}>
                <EventChip instance={i} tz={tz} compact onOpen={onOpen} />
              </li>
            ))}
          </ul>
        ))}
      </div>
      <div className="pr-cal-week__scroll" ref={scrollRef} tabIndex={0} role="region" aria-label="Events by time">
        <div className="pr-cal-week__row pr-cal-week__body" style={{ height: `${String(24 * HOUR_PX)}px` }}>
          <div className="pr-cal-week__gutter pr-cal-week__hours" aria-hidden="true">
            {hours.map((h) => (
              <span key={h} style={{ top: `${String(h * HOUR_PX)}px` }}>
                {h === 0 ? '' : hourLabel(h)}
              </span>
            ))}
          </div>
          {perDay.map(({ day, timed }) => (
            <div
              key={day}
              className="pr-cal-week__col"
              data-today={day === todayDay ? 'true' : undefined}
              data-day={day}
              onClick={(e) => {
                // A click on empty time starts an event at that half hour (the keyboard has "New event").
                const rect = e.currentTarget.getBoundingClientRect();
                const minutes = Math.floor(((e.clientY - rect.top) / rect.height) * 48) * 30;
                onNew(day, Math.max(0, Math.min(minutes, MINUTES_PER_DAY - 60)));
              }}
            >
              <ul className="pr-cal-week__events" aria-label={`Events, ${dayLabel(day)}`}>
                {layoutTimed(timed, day, tz).map((p) => (
                  <li
                    key={`${p.instance.calendarId}/${p.instance.name}/${p.instance.recurrenceId}`}
                    className="pr-cal-week__event"
                    style={{
                      top: `${String((p.top / MINUTES_PER_DAY) * 100)}%`,
                      height: `${String(((p.bottom - p.top) / MINUTES_PER_DAY) * 100)}%`,
                      left: `${String((p.column / p.columns) * 100)}%`,
                      width: `${String(100 / p.columns)}%`,
                    }}
                  >
                    <EventChip instance={p.instance} tz={tz} compact={p.bottom - p.top < 40} onOpen={onOpen} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Agenda({
  days,
  instances,
  tz,
  todayDay,
  onOpen,
  onNew,
}: {
  days: string[];
  instances: EventInstance[];
  tz: string;
  todayDay: string;
  onOpen: (i: EventInstance) => void;
  onNew: (day: string) => void;
}) {
  const withEvents = days
    .map((d) => {
      const on = instancesOnDay(instances, d, tz);
      return { day: d, events: [...on.allDay, ...on.timed] };
    })
    .filter((d) => d.events.length > 0);
  if (withEvents.length === 0) {
    return (
      <EmptyState kind="empty" heading="Nothing scheduled" headingLevel={2} action={<Button onClick={() => { onNew(days[0] ?? todayDay); }}>New event</Button>}>
        No events in this {days.length === 1 ? 'day' : days.length === 7 ? 'week' : 'month'}.
      </EmptyState>
    );
  }
  return (
    <ol className="pr-cal-agenda">
      {withEvents.map(({ day, events }) => (
        <li key={day}>
          <h3 className="pr-cal-agenda__day" data-today={day === todayDay ? 'true' : undefined}>
            {dayLabel(day)}
            {day === todayDay ? ' (today)' : ''}
          </h3>
          <ul className="pr-cal-agenda__events">
            {events.map((i) => (
              <li key={`${i.calendarId}/${i.name}/${i.recurrenceId}`}>
                <button
                  type="button"
                  className="pr-cal-agenda__event"
                  onClick={() => {
                    onOpen(i);
                  }}
                >
                  <span className="pr-cal-agenda__time">{i.allDay ? 'All day' : `${timeLabel(i.start, tz)} – ${timeLabel(i.end, tz)}`}</span>
                  <span className="pr-cal-agenda__title">{i.summary === '' ? 'Untitled event' : i.summary}</span>
                  {i.location === '' ? null : <span className="pr-cal-agenda__where">{i.location}</span>}
                </button>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}
