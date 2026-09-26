// The template manager (PST-T-9.2, PST-REQ-144): create, edit and delete the saved templates the
// composer's `;` shortcut offers. CRUD over /api/templates, every mutation audited server-side.
import { type SyntheticEvent, useCallback, useEffect, useState } from 'react';
import { Alert, Button, EmptyState, FormActions, FormField, Input, Page, PageHeader, Section, Stack, Table, Textarea, type TableColumn } from '@d3cloud/ui';
import { describeError } from '../api';
import { templatesApi, type TemplateJson } from './api';
import { Loading, LoadFailed } from '../screens/states';

interface FormState {
  id: string | null;
  shortcut: string;
  name: string;
  subject: string;
  body: string;
}

const BLANK: FormState = { id: null, shortcut: '', name: '', subject: '', body: '' };

export function TemplatesScreen() {
  const [rows, setRows] = useState<TemplateJson[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [form, setForm] = useState<FormState>(BLANK);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows((await templatesApi.list()).templates);
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = (event: SyntheticEvent) => {
    event.preventDefault();
    setFormError(null);
    setNotice(null);
    if (form.shortcut.trim() === '' || form.name.trim() === '' || form.body.trim() === '') {
      setFormError('A shortcut, a name and a body are all required.');
      return;
    }
    const input = { shortcut: form.shortcut.trim(), name: form.name.trim(), body: form.body, ...(form.subject.trim() === '' ? {} : { subject: form.subject.trim() }) };
    setBusy(true);
    const call = form.id === null ? templatesApi.create(input) : templatesApi.update(form.id, input);
    call
      .then(async (created) => {
        setNotice(form.id === null ? `Created ;${created.template.shortcut}.` : `Saved ;${created.template.shortcut}.`);
        setForm(BLANK);
        await load();
      })
      .catch((caught: unknown) => {
        setFormError(describeError(caught));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const edit = (row: TemplateJson) => {
    setForm({ id: row.id, shortcut: row.shortcut, name: row.name, subject: row.subject ?? '', body: row.body });
    setFormError(null);
  };

  const remove = (row: TemplateJson) => {
    setNotice(null);
    templatesApi
      .remove(row.id)
      .then(async () => {
        setNotice(`Deleted ;${row.shortcut}.`);
        if (form.id === row.id) setForm(BLANK);
        await load();
      })
      .catch((caught: unknown) => {
        setNotice(describeError(caught));
      });
  };

  const columns: TableColumn<TemplateJson>[] = [
    { key: 'shortcut', header: 'Shortcut', cell: (t) => `;${t.shortcut}` },
    { key: 'name', header: 'Name', cell: (t) => t.name },
    { key: 'subject', header: 'Subject', cell: (t) => t.subject ?? '—' },
    {
      key: 'actions',
      header: 'Actions',
      align: 'end',
      cell: (t) => (
        <>
          <Button variant="ghost" size="sm" aria-label={`Edit ${t.name}`} onClick={() => { edit(t); }}>
            Edit
          </Button>
          <Button variant="danger-ghost" size="sm" aria-label={`Delete ${t.name}`} onClick={() => { remove(t); }}>
            Delete
          </Button>
        </>
      ),
    },
  ];

  return (
    <Page>
      <PageHeader
        title="Compose templates"
        description="Type ; in the composer to insert one. {{name}}, {{first_name}} and {{date}} are filled in when it's inserted."
        {...(rows === null ? {} : { count: rows.length, countNoun: { one: 'template', other: 'templates' } })}
      />
      {notice === null ? null : (
        <Alert tone="info" dynamic>
          {notice}
        </Alert>
      )}

      <Section title={form.id === null ? 'New template' : `Editing ;${form.shortcut}`}>
        <form onSubmit={save}>
          <Stack gap="16">
            <FormField label="Shortcut" help="What ; matches on, e.g. sig (without the ;).">
              <Input
                maxLength={64}
                required
                value={form.shortcut}
                onChange={(e) => {
                  setForm((f) => ({ ...f, shortcut: e.target.value }));
                }}
              />
            </FormField>
            <FormField label="Name">
              <Input
                maxLength={200}
                required
                value={form.name}
                onChange={(e) => {
                  setForm((f) => ({ ...f, name: e.target.value }));
                }}
              />
            </FormField>
            <FormField label="Subject" optional>
              <Input
                value={form.subject}
                onChange={(e) => {
                  setForm((f) => ({ ...f, subject: e.target.value }));
                }}
              />
            </FormField>
            <FormField label="Body" help="Markdown. Use {{name}}, {{first_name}} or {{date}}." {...(formError === null ? {} : { error: formError })}>
              <Textarea
                rows={8}
                required
                value={form.body}
                onChange={(e) => {
                  setForm((f) => ({ ...f, body: e.target.value }));
                }}
              />
            </FormField>
            <FormActions>
              {form.id === null ? null : (
                <Button type="button" variant="ghost" onClick={() => { setForm(BLANK); }}>
                  Cancel
                </Button>
              )}
              <Button type="submit" variant="primary" loading={busy}>
                {form.id === null ? 'Create template' : 'Save template'}
              </Button>
            </FormActions>
          </Stack>
        </form>
      </Section>

      {loadError !== null ? (
        <LoadFailed error={loadError} what="templates" onRetry={() => void load()} />
      ) : rows === null ? (
        <Loading label="Loading templates" />
      ) : (
        <Table caption="Your compose templates" columns={columns} rows={rows} rowKey={(t) => t.id} empty={<EmptyState kind="empty" heading="No templates yet" size="row" />} />
      )}
    </Page>
  );
}
