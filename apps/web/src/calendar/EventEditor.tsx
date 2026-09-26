import { type SyntheticEvent, useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Cluster, FormField, Input, Modal, ModalClose, SegmentedControl, Select, Skeleton, Stack, Textarea } from '@d3cloud/ui';
import { ApiError, calendarApi, describeError, type Calendar, type EventDetail, type EventInput, type EventInstance, type Weekday } from '../api';
import { addDays, zonedDay, zonedMinutes } from './layout';
import { defaultRecurrenceForm, describeRecurrence, detailToForm, formToRecurrence, WEEKDAY_NAMES, WEEKDAYS, type EndKind, type RecurrenceForm, type RepeatKind } from './recurrence';

/** What the editor was opened for: a new event on a day (and time), or an instance to edit. */
export type EditorTarget = { kind: 'new'; day: string; minutes: number | null } | { kind: 'edit'; instance: EventInstance };

interface FormState {
  summary: string;
  location: string;
  description: string;
  allDay: boolean;
  startDay: string;
  startTime: string;
  /** Inclusive for all-day events (the API's end is exclusive). */
  endDay: string;
  endTime: string;
  timezone: string;
  recurrence: RecurrenceForm;
}

const pad = (n: number): string => String(n).padStart(2, '0');
const hhmm = (minutes: number): string => `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;

function freshForm(day: string, minutes: number | null, tz: string): FormState {
  const start = minutes ?? 9 * 60;
  const end = Math.min(start + 60, 23 * 60 + 59);
  return { summary: '', location: '', description: '', allDay: false, startDay: day, startTime: hhmm(start), endDay: day, endTime: hhmm(end), timezone: tz, recurrence: defaultRecurrenceForm(day) };
}

/** The form for the whole series (the master's own start and end, in the event's zone). */
function seriesForm(d: EventDetail, tz: string): { form: FormState; editableRule: boolean } {
  const startDay = d.start.slice(0, 10);
  const rule = detailToForm(d, startDay);
  return {
    form: {
      summary: d.summary,
      location: d.location,
      description: d.description,
      allDay: d.allDay,
      startDay,
      startTime: d.allDay ? '09:00' : d.start.slice(11, 16),
      endDay: d.allDay ? addDays(d.end.slice(0, 10), -1) : d.end.slice(0, 10),
      endTime: d.allDay ? '10:00' : d.end.slice(11, 16),
      timezone: d.timezone ?? tz,
      recurrence: rule ?? defaultRecurrenceForm(startDay),
    },
    editableRule: rule !== null,
  };
}

/** The form for one instance (its own start and end, read in the event's zone). */
function instanceForm(d: EventDetail, i: EventInstance, tz: string): FormState {
  const zone = d.timezone ?? tz;
  const base = seriesForm(d, tz).form;
  if (i.allDay) {
    const s = i.startDay ?? zonedDay(i.start, zone);
    const e = i.endDay ?? addDays(s, 1);
    return { ...base, summary: i.summary, location: i.location, allDay: true, startDay: s, endDay: addDays(e, -1) };
  }
  return {
    ...base,
    summary: i.summary,
    location: i.location,
    allDay: false,
    startDay: zonedDay(i.start, zone),
    startTime: hhmm(zonedMinutes(i.start, zone)),
    endDay: zonedDay(i.end, zone),
    endTime: hhmm(zonedMinutes(i.end, zone)),
  };
}

function inputOf(f: FormState): Omit<EventInput, 'recurrence'> {
  return {
    summary: f.summary,
    location: f.location,
    description: f.description,
    allDay: f.allDay,
    start: f.allDay ? f.startDay : `${f.startDay}T${f.startTime}`,
    end: f.allDay ? addDays(f.endDay, 1) : `${f.endDay}T${f.endTime}`,
    timezone: f.timezone,
  };
}

/** A problem the form can name before asking the server, or null. */
export function formProblem(f: FormState): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.startDay) || !/^\d{4}-\d{2}-\d{2}$/.test(f.endDay)) return 'Choose a start and end date.';
  if (f.allDay ? f.endDay < f.startDay : `${f.endDay}T${f.endTime}` < `${f.startDay}T${f.startTime}`) return 'The event cannot end before it starts.';
  if (f.recurrence.repeat === 'WEEKLY' && f.recurrence.byDay.length === 0) return 'Choose at least one day of the week.';
  if (f.recurrence.repeat !== 'none' && f.recurrence.end === 'until' && f.recurrence.until < f.startDay) return 'The series cannot end before it starts.';
  return null;
}

const REPEAT_OPTIONS: { value: RepeatKind; label: string }[] = [
  { value: 'none', label: 'Does not repeat' },
  { value: 'DAILY', label: 'Daily' },
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'YEARLY', label: 'Yearly' },
];
const END_OPTIONS: { value: EndKind; label: string }[] = [
  { value: 'never', label: 'Never' },
  { value: 'count', label: 'After a number of times' },
  { value: 'until', label: 'On a date' },
];
const UNITS: Record<Exclude<RepeatKind, 'none'>, string> = { DAILY: 'days', WEEKLY: 'weeks', MONTHLY: 'months', YEARLY: 'years' };

export function EventEditor({
  target,
  calendars,
  tz,
  onClose,
  onChanged,
}: {
  target: EditorTarget | null;
  calendars: Calendar[];
  tz: string;
  onClose: () => void;
  /** After a save or delete: the notice to show, and the list reloads. */
  onChanged: (notice: string) => void;
}) {
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [editableRule, setEditableRule] = useState(true);
  const [scope, setScope] = useState<'this' | 'all'>('this');
  const [calendarId, setCalendarId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const recurring = target?.kind === 'edit' && target.instance.recurring;

  useEffect(() => {
    setError(null);
    setConfirmDelete(false);
    setDetail(null);
    setForm(null);
    if (target === null) return;
    if (target.kind === 'new') {
      setCalendarId(calendars.find((c) => c.canHoldEvents)?.id ?? '');
      setForm(freshForm(target.day, target.minutes, tz));
      setEditableRule(true);
      return;
    }
    setCalendarId(target.instance.calendarId);
    setScope(target.instance.recurring ? 'this' : 'all');
    let live = true;
    calendarApi
      .event(target.instance.calendarId, target.instance.name)
      .then((d) => {
        if (!live) return;
        setDetail(d);
        const series = seriesForm(d, tz);
        setEditableRule(series.editableRule);
        setForm(target.instance.recurring ? instanceForm(d, target.instance, tz) : series.form);
      })
      .catch((caught: unknown) => {
        if (live) setError(describeError(caught));
      });
    return () => {
      live = false;
    };
  }, [target, calendars, tz]);

  // Switching between "this event" and "all events" shows that scope's own times.
  const chooseScope = (next: 'this' | 'all') => {
    setScope(next);
    if (detail === null || target?.kind !== 'edit') return;
    setForm(next === 'all' ? seriesForm(detail, tz).form : instanceForm(detail, target.instance, tz));
  };

  const set = (patch: Partial<FormState>) => {
    setForm((f) => (f === null ? f : { ...f, ...patch }));
  };
  const setRule = (patch: Partial<RecurrenceForm>) => {
    setForm((f) => (f === null ? f : { ...f, recurrence: { ...f.recurrence, ...patch } }));
  };

  const failed = (caught: unknown) => {
    if (caught instanceof ApiError && caught.status === 412) {
      setError('This event was changed somewhere else (on your phone, perhaps). Close and open it again to see the latest.');
      return;
    }
    setError(describeError(caught));
  };

  const save = (event: SyntheticEvent) => {
    event.preventDefault();
    if (form === null || target === null) return;
    const problem = formProblem(form);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setError(null);
    setBusy(true);
    const base = inputOf(form);
    let request: Promise<unknown>;
    if (target.kind === 'new') {
      request = calendarApi.create(calendarId, { ...base, recurrence: formToRecurrence(form.recurrence) });
    } else if (detail === null) {
      return;
    } else if (recurring && scope === 'this') {
      request = calendarApi.updateInstance(detail.calendarId, detail.name, target.instance.recurrenceId, detail.etag, base);
    } else {
      request = calendarApi.update(detail.calendarId, detail.name, detail.etag, editableRule ? { ...base, recurrence: formToRecurrence(form.recurrence) } : base);
    }
    request
      .then(() => {
        onChanged(target.kind === 'new' ? `Added “${form.summary.trim() === '' ? 'New event' : form.summary.trim()}”.` : 'Saved.');
      })
      .catch(failed)
      .finally(() => {
        setBusy(false);
      });
  };

  const remove = () => {
    if (detail === null || target?.kind !== 'edit') return;
    setBusy(true);
    const request = recurring && scope === 'this' ? calendarApi.removeInstance(detail.calendarId, detail.name, target.instance.recurrenceId, detail.etag) : calendarApi.remove(detail.calendarId, detail.name, detail.etag);
    request
      .then(() => {
        onChanged(recurring && scope === 'this' ? 'Deleted this event.' : 'Deleted.');
      })
      .catch(failed)
      .finally(() => {
        setBusy(false);
        setConfirmDelete(false);
      });
  };

  const eventCalendars = calendars.filter((c) => c.canHoldEvents);
  const showRule = form !== null && (target?.kind === 'new' || !recurring || scope === 'all');

  return (
    <Modal
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="lg"
      title={target?.kind === 'new' ? 'New event' : 'Edit event'}
      footer={
        <>
          {target?.kind === 'edit' && detail !== null ? (
            confirmDelete ? (
              <Button type="button" variant="danger" loading={busy} onClick={remove}>
                {recurring && scope === 'this' ? 'Delete this event' : recurring ? 'Delete every event' : 'Delete event'}
              </Button>
            ) : (
              <Button
                type="button"
                variant="danger-ghost"
                onClick={() => {
                  setConfirmDelete(true);
                }}
              >
                Delete…
              </Button>
            )
          ) : null}
          <ModalClose>
            <Button type="button">Cancel</Button>
          </ModalClose>
          <Button type="submit" form="pr-event-form" variant="primary" loading={busy} disabled={form === null}>
            Save
          </Button>
        </>
      }
    >
      {form === null ? (
        error === null ? (
          <Skeleton variant="block" />
        ) : (
          <Alert tone="danger" title="Could not open the event">
            {error}
          </Alert>
        )
      ) : (
        <form id="pr-event-form" onSubmit={save} noValidate>
          <Stack gap="16">
            {error === null ? null : (
              <Alert tone="danger" dynamic>
                {error}
              </Alert>
            )}
            {recurring ? (
              <FormField label="Change" as="group">
                <SegmentedControl
                  aria-label="Change"
                  items={[
                    { value: 'this', label: 'This event' },
                    { value: 'all', label: 'All events' },
                  ]}
                  value={scope}
                  onValueChange={(v) => {
                    chooseScope(v === 'all' ? 'all' : 'this');
                  }}
                />
              </FormField>
            ) : null}
            <FormField label="Title">
              <Input
                value={form.summary}
                placeholder="New event"
                onChange={(e) => {
                  set({ summary: e.target.value });
                }}
              />
            </FormField>
            {target?.kind === 'new' && eventCalendars.length > 1 ? (
              <FormField label="Calendar" width="md">
                <Select options={eventCalendars.map((c) => ({ value: c.id, label: c.displayName }))} value={calendarId} onValueChange={setCalendarId} />
              </FormField>
            ) : null}
            <Checkbox
              label="All day"
              checked={form.allDay}
              onCheckedChange={(c) => {
                set({ allDay: c === true });
              }}
            />
            <Cluster gap="12">
              <FormField label="Start date" width="sm">
                <Input
                  type="date"
                  value={form.startDay}
                  onChange={(e) => {
                    const startDay = e.target.value;
                    // Moving the start moves the end with it, keeping the length in days.
                    const shift = form.endDay >= form.startDay ? Math.round((Date.parse(form.endDay) - Date.parse(form.startDay)) / 86_400_000) : 0;
                    set({ startDay, endDay: /^\d{4}-\d{2}-\d{2}$/.test(startDay) ? addDays(startDay, shift) : form.endDay });
                  }}
                />
              </FormField>
              {form.allDay ? null : (
                <FormField label="Start time" width="xs">
                  <Input
                    type="time"
                    value={form.startTime}
                    onChange={(e) => {
                      set({ startTime: e.target.value });
                    }}
                  />
                </FormField>
              )}
              <FormField label="End date" width="sm">
                <Input
                  type="date"
                  value={form.endDay}
                  onChange={(e) => {
                    set({ endDay: e.target.value });
                  }}
                />
              </FormField>
              {form.allDay ? null : (
                <FormField label="End time" width="xs">
                  <Input
                    type="time"
                    value={form.endTime}
                    onChange={(e) => {
                      set({ endTime: e.target.value });
                    }}
                  />
                </FormField>
              )}
            </Cluster>
            {form.allDay ? null : <p className="pr-cal-note">Times are in {form.timezone}.</p>}
            {showRule ? (
              editableRule ? (
                <RecurrenceFields form={form.recurrence} onChange={setRule} />
              ) : (
                <p className="pr-cal-note">Repeats by a rule this form cannot show ({detail?.recurrence?.rule ?? ''}); it is kept as it is.</p>
              )
            ) : (
              <p className="pr-cal-note">Changes apply to this event only; the rest of the series is unchanged.</p>
            )}
            <FormField label="Location" optional>
              <Input
                value={form.location}
                onChange={(e) => {
                  set({ location: e.target.value });
                }}
              />
            </FormField>
            <FormField label="Notes" optional>
              <Textarea
                rows={3}
                value={form.description}
                onChange={(e) => {
                  set({ description: e.target.value });
                }}
              />
            </FormField>
          </Stack>
        </form>
      )}
    </Modal>
  );
}

function RecurrenceFields({ form, onChange }: { form: RecurrenceForm; onChange: (patch: Partial<RecurrenceForm>) => void }) {
  const toggleDay = (day: Weekday, on: boolean) => {
    onChange({ byDay: on ? [...form.byDay.filter((d) => d !== day), day] : form.byDay.filter((d) => d !== day) });
  };
  return (
    <Stack gap="12">
      <FormField label="Repeat" width="md" help={describeRecurrence(form)}>
        <Select
          options={REPEAT_OPTIONS}
          value={form.repeat}
          onValueChange={(v) => {
            onChange({ repeat: v as RepeatKind });
          }}
        />
      </FormField>
      {form.repeat === 'none' ? null : (
        <>
          <FormField label={`Every how many ${UNITS[form.repeat]}`} width="xs">
            <Input
              type="number"
              min={1}
              max={999}
              value={String(form.interval)}
              onChange={(e) => {
                const n = Number(e.target.value);
                onChange({ interval: Number.isInteger(n) && n >= 1 ? n : 1 });
              }}
            />
          </FormField>
          {form.repeat === 'WEEKLY' ? (
            <FormField label="On" as="group">
              <Cluster gap="12">
                {WEEKDAYS.map((d) => (
                  <Checkbox
                    key={d}
                    label={WEEKDAY_NAMES[d].short}
                    aria-label={WEEKDAY_NAMES[d].long}
                    checked={form.byDay.includes(d)}
                    onCheckedChange={(c) => {
                      toggleDay(d, c === true);
                    }}
                  />
                ))}
              </Cluster>
            </FormField>
          ) : null}
          <Cluster gap="12">
            <FormField label="Series ends" width="md">
              <Select
                options={END_OPTIONS}
                value={form.end}
                onValueChange={(v) => {
                  onChange({ end: v as EndKind });
                }}
              />
            </FormField>
            {form.end === 'count' ? (
              <FormField label="Times" width="xs">
                <Input
                  type="number"
                  min={1}
                  max={5000}
                  value={String(form.count)}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    onChange({ count: Number.isInteger(n) && n >= 1 ? n : 1 });
                  }}
                />
              </FormField>
            ) : null}
            {form.end === 'until' ? (
              <FormField label="Last day" width="sm">
                <Input
                  type="date"
                  value={form.until}
                  onChange={(e) => {
                    onChange({ until: e.target.value });
                  }}
                />
              </FormField>
            ) : null}
          </Cluster>
        </>
      )}
    </Stack>
  );
}
