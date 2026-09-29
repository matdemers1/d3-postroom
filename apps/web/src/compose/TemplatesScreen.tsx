// The template manager (PST-T-9.2, PST-REQ-144): create, edit and delete the saved templates the
// composer's `;` shortcut offers. CRUD over /api/templates, every mutation audited server-side.
import '../settings/settings.css';
import { type SyntheticEvent, useCallback, useEffect, useState } from 'react';
import { Alert, Button, DataList, DataListRow, EmptyState, FormActions, FormField, Input, Modal, ModalClose, Page, PageHeader, Section, Stack, Textarea } from '@d3cloud/ui';
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
  const [confirming, setConfirming] = useState<TemplateJson | null>(null);
  const [removing, setRemoving] = useState(false);

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
    setRemoving(true);
    templatesApi
      .remove(row.id)
      .then(async () => {
        setConfirming(null);
        setNotice(`Deleted ;${row.shortcut}.`);
        if (form.id === row.id) setForm(BLANK);
        await load();
      })
      .catch((caught: unknown) => {
        setNotice(describeError(caught));
      })
      .finally(() => {
        setRemoving(false);
      });
  };

  return (
    // PST-T-15.6: the settings grid — a 680px column of Section cards; each template is a row.
    <Page width="narrow">
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
            <FormField label="Shortcut" width="sm" help="What ; matches on, e.g. sig (without the ;).">
              <Input
                appearance="filled"
                maxLength={64}
                required
                value={form.shortcut}
                onChange={(e) => {
                  setForm((f) => ({ ...f, shortcut: e.target.value }));
                }}
              />
            </FormField>
            <FormField label="Name" width="lg">
              <Input
                appearance="filled"
                maxLength={200}
                required
                value={form.name}
                onChange={(e) => {
                  setForm((f) => ({ ...f, name: e.target.value }));
                }}
              />
            </FormField>
            <FormField label="Subject" width="lg" optional>
              <Input
                appearance="filled"
                value={form.subject}
                onChange={(e) => {
                  setForm((f) => ({ ...f, subject: e.target.value }));
                }}
              />
            </FormField>
            <FormField label="Body" help="Markdown. Use {{name}}, {{first_name}} or {{date}}." {...(formError === null ? {} : { error: formError })}>
              <Textarea
                appearance="filled"
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
        <Section title="Your templates">
          <DataList aria-label="Your compose templates" empty={<EmptyState kind="empty" heading="No templates yet" headingLevel={3} size="inline" />}>
            {rows.map((t) => (
              <DataListRow
                key={t.id}
                title={t.name}
                description={t.subject === null || t.subject === '' ? 'No subject' : `Subject: ${t.subject}`}
                meta={<span className="pr-set-mono">;{t.shortcut}</span>}
                actions={
                  <>
                    <Button variant="ghost" size="sm" aria-label={`Edit ${t.name}`} onClick={() => { edit(t); }}>
                      Edit
                    </Button>
                    <Button variant="danger-ghost" size="sm" aria-label={`Delete ${t.name}`} onClick={() => { setConfirming(t); }}>
                      Delete
                    </Button>
                  </>
                }
              />
            ))}
          </DataList>
        </Section>
      )}

      <Modal
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        destructive
        title="Delete this template?"
        description={confirming === null ? '' : `;${confirming.shortcut} is removed from the composer's list. This cannot be undone.`}
        footer={
          <>
            <ModalClose>
              <Button type="button">Cancel</Button>
            </ModalClose>
            <Button
              type="button"
              variant="danger"
              loading={removing}
              onClick={() => {
                if (confirming !== null) remove(confirming);
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        {null}
      </Modal>
    </Page>
  );
}
