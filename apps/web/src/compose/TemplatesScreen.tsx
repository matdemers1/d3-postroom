// The template manager (PST-T-9.2, PST-REQ-144): create, edit and delete the saved templates the
// composer's `;` shortcut offers. CRUD over /api/templates, every mutation audited server-side.
//
// PST-T-17.10: one "Saved replies" card. Its head holds New template; the form (new or edit) opens
// inside it above the list on the 164/360 grid; each row is the name with its shortcut as a key chip,
// a body preview under it, and one Edit button — Delete lives at the foot of the edit form, so a long
// list is not a wall of red.
import '../settings/settings.css';
import '../screens/inline-forms.css';
import { type SyntheticEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, DataList, DataListRow, EmptyState, FormActions, FormField, Input, Modal, ModalClose, Page, PageHeader, Section, Textarea } from '@d3cloud/ui';
import { describeError } from '../api';
import { templatesApi, type TemplateJson } from './api';
import { templateDescription } from './template-preview';
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
  // PST-T-16.23: the form is not in the DOM until "New template" (or a row's Edit) opens it.
  const [open, setOpen] = useState(false);
  // PST-T-16.23: the card's New button unmounts while the form is open; folding the form away
  // (Cancel, or done) hands focus back to it, as Account's Change password does.
  const newButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (!open && returnFocus.current) {
      returnFocus.current = false;
      newButton.current?.focus();
    }
  }, [open]);
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

  const closeForm = () => {
    returnFocus.current = true;
    setOpen(false);
    setForm(BLANK);
    setFormError(null);
  };

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
        closeForm();
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
    setNotice(null);
    setForm({ id: row.id, shortcut: row.shortcut, name: row.name, subject: row.subject ?? '', body: row.body });
    setFormError(null);
    setOpen(true);
  };

  const remove = (row: TemplateJson) => {
    setNotice(null);
    setRemoving(true);
    templatesApi
      .remove(row.id)
      .then(async () => {
        setConfirming(null);
        setNotice(`Deleted ;${row.shortcut}.`);
        if (form.id === row.id) closeForm();
        await load();
      })
      .catch((caught: unknown) => {
        setNotice(describeError(caught));
      })
      .finally(() => {
        setRemoving(false);
      });
  };

  const editing = form.id === null ? null : (rows?.find((t) => t.id === form.id) ?? null);

  return (
    // PST-T-15.6: the settings grid — a 680px column, centred (PST-T-17.10); each template is a row.
    <Page width="narrow" align="center">
      <PageHeader
        title="Templates"
        description="Saved replies you can drop into any message."
        {...(rows === null || rows.length === 0 ? {} : { count: rows.length, countNoun: { one: 'template', other: 'templates' } })}
      />

      <Section
        title="Saved replies"
        actions={
          open ? null : (
            <Button
              ref={newButton}
              size="sm"
              variant="primary"
              onClick={() => {
                setNotice(null);
                setForm(BLANK);
                setOpen(true);
              }}
            >
              New template
            </Button>
          )
        }
      >
        {notice === null ? null : (
          <Alert tone="info" dynamic>
            {notice}
          </Alert>
        )}

        {!open ? null : (
          <form className="pr-setform pr-inline-form" aria-labelledby="template-form" onSubmit={save}>
            <div className="pr-inline-form__head">
              <h3 id="template-form" className="pr-inline-form__title">
                {form.id === null ? 'New template' : `Edit ${editing?.name ?? 'template'}`}
              </h3>
            </div>
            <FormField
              label="Shortcut"
              width="sm"
              help={
                <>
                  Type <code>;sig</code> in a message to insert the template whose shortcut is sig.
                </>
              }
            >
              <Input
                appearance="filled"
                autoFocus
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
            <FormField label="Body" width="lg" help="Markdown. Use {{name}}, {{first_name}} or {{date}}." {...(formError === null ? {} : { error: formError })}>
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
            <FormActions
              className="pr-setform__actions"
              {...(editing === null
                ? {}
                : {
                    leading: (
                      <Button
                        type="button"
                        variant="danger-ghost"
                        onClick={() => {
                          setConfirming(editing);
                        }}
                      >
                        Delete
                      </Button>
                    ),
                  })}
            >
              <Button type="button" onClick={closeForm}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={busy}>
                {form.id === null ? 'Create template' : 'Save template'}
              </Button>
            </FormActions>
          </form>
        )}

        {loadError !== null ? (
          <LoadFailed error={loadError} what="templates" onRetry={() => void load()} headingLevel={3} size="row" />
        ) : rows === null ? (
          <Loading label="Loading templates" height={96} />
        ) : open && rows.length === 0 ? null : (
          <DataList
            aria-label="Your saved replies"
            empty={
              <EmptyState kind="empty" heading="No templates yet" headingLevel={3} size="row">
                Save a reply you send often, then type its shortcut in any message.
              </EmptyState>
            }
          >
            {rows.map((t) => (
              <DataListRow
                key={t.id}
                title={
                  <>
                    {t.name}{' '}
                    <kbd className="pr-tpl-key">;{t.shortcut}</kbd>
                  </>
                }
                description={templateDescription(t)}
                actions={
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={`Edit ${t.name}`}
                    onClick={() => {
                      edit(t);
                    }}
                  >
                    Edit
                  </Button>
                }
              />
            ))}
          </DataList>
        )}
      </Section>

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
