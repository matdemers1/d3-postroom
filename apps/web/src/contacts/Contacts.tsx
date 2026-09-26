import './contacts.css';
import { type SyntheticEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Link as RouterLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Cluster,
  DataList,
  DataListRow,
  DescriptionItem,
  DescriptionList,
  EmptyState,
  FilterBar,
  FormActions,
  FormField,
  IconButton,
  Input,
  Modal,
  ModalClose,
  Page,
  PageHeader,
  Section,
  Select,
  Skeleton,
  Stack,
  Textarea,
} from '@d3cloud/ui';
import { ApiError, contactPath, contactsApi, describeError, type AddressBook, type ContactDetail, type ContactInput, type ContactSummary } from '../api';
import { useMediaQuery } from '../mail/useMedia';
import { blankContact, contactProblem, EMAIL_TYPES, inputOf, rowKey, TEL_TYPES, toForm, typeOptions, type ContactForm } from './form';

const SPLIT_QUERY = '(min-width: 900px)';

function RemoveIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

/**
 * Contacts (PST-T-8.5, PST-REQ-137): every address book the account syncs over CardDAV — its own,
 * and "Collected", which sending mail fills (PST-REQ-138). Search, view, add, edit and delete; an
 * edit is the same write an iPhone makes, so the phone's next sync picks it up.
 */
export function Contacts() {
  const params = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const split = useMediaQuery(SPLIT_QUERY);
  const creating = location.pathname === '/contacts/new';
  const selected = !creating && params['addressBookId'] !== undefined && params['name'] !== undefined ? { addressBookId: params['addressBookId'], name: params['name'] } : null;

  const [books, setBooks] = useState<AddressBook[] | null>(null);
  const [contacts, setContacts] = useState<ContactSummary[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState('');
  const [bookFilter, setBookFilter] = useState('all');
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [b, c] = await Promise.all([contactsApi.addressBooks(), contactsApi.list()]);
      setBooks(b.addressBooks);
      setContacts(c.contacts);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const bookName = useMemo(() => new Map((books ?? []).map((b) => [b.id, b.displayName])), [books]);
  const needle = query.trim().toLowerCase();
  const shown = (contacts ?? []).filter(
    (c) => (bookFilter === 'all' || c.addressBookId === bookFilter) && (needle === '' || [c.displayName, c.org, ...c.emails].some((x) => x.toLowerCase().includes(needle))),
  );

  const showList = split || (selected === null && !creating);
  const showDetail = split || selected !== null || creating;

  const list = (
    <div className="pr-contacts__list">
      <FilterBar aria-label="Filter contacts">
        <Input
          type="search"
          aria-label="Search contacts"
          placeholder="Search by name, e-mail or organisation"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
        />
        {books !== null && books.length > 1 ? (
          <Select
            aria-label="Address book"
            options={[{ value: 'all', label: 'All address books' }, ...books.map((b) => ({ value: b.id, label: `${b.displayName} (${String(b.count)})` }))]}
            value={bookFilter}
            onValueChange={setBookFilter}
          />
        ) : null}
      </FilterBar>
      {loadError ? (
        <EmptyState kind="error" heading="Could not load contacts" headingLevel={2} action={<Button onClick={() => void load()}>Try again</Button>}>
          The server did not answer.
        </EmptyState>
      ) : contacts === null ? (
        <Skeleton variant="block" />
      ) : (
        <DataList
          aria-label="Contacts"
          empty={
            <EmptyState kind={contacts.length === 0 ? 'empty' : 'no-results'} heading={contacts.length === 0 ? 'No contacts yet' : 'No contacts match'} size="row">
              {contacts.length === 0 ? 'People you write to are added to Collected automatically.' : 'Try another search.'}
            </EmptyState>
          }
        >
          {shown.map((c) => (
            <DataListRow
              key={`${c.addressBookId}/${c.name}`}
              aria-current={selected?.addressBookId === c.addressBookId && selected.name === c.name ? 'true' : undefined}
              title={<RouterLink to={contactPath(c.addressBookId, c.name)}>{c.displayName === '' ? 'No name' : c.displayName}</RouterLink>}
              description={[c.org, ...c.emails].filter((x) => x !== '').join(' · ')}
              meta={bookName.get(c.addressBookId) ?? ''}
              truncate
            />
          ))}
        </DataList>
      )}
    </div>
  );

  let detail;
  if (creating) {
    detail = (
      <ContactEditor
        key="new"
        books={books ?? []}
        existing={null}
        onCancel={() => {
          void navigate('/contacts');
        }}
        onSaved={(saved, message) => {
          setNotice(message);
          void load();
          void navigate(contactPath(saved.addressBookId, saved.name), { replace: true });
        }}
      />
    );
  } else if (selected !== null) {
    detail = (
      <ContactPane
        key={`${selected.addressBookId}/${selected.name}`}
        addressBookId={selected.addressBookId}
        name={selected.name}
        books={books ?? []}
        onChanged={(message, gone) => {
          setNotice(message);
          void load();
          if (gone) void navigate('/contacts', { replace: true });
        }}
      />
    );
  } else {
    detail = (
      <EmptyState kind="empty" heading="Choose a contact" headingLevel={2} size="inline">
        Or add one with New contact.
      </EmptyState>
    );
  }

  return (
    <Page width="wide">
      <PageHeader
        title="Contacts"
        {...(contacts === null ? {} : { count: contacts.length, countNoun: { one: 'contact', other: 'contacts' } })}
        {...(!split && (selected !== null || creating) ? { back: <RouterLink to="/contacts">All contacts</RouterLink> } : {})}
        actions={
          <Button
            variant="primary"
            onClick={() => {
              setNotice(null);
              void navigate('/contacts/new');
            }}
          >
            New contact
          </Button>
        }
      />
      {notice === null ? null : (
        <Alert tone="success" dynamic>
          {notice}
        </Alert>
      )}
      <div className="pr-contacts" data-split={split ? 'true' : undefined}>
        {showList ? list : null}
        {showDetail ? <div className="pr-contacts__detail">{detail}</div> : null}
      </div>
    </Page>
  );
}

function ContactPane({
  addressBookId,
  name,
  books,
  onChanged,
}: {
  addressBookId: string;
  name: string;
  books: AddressBook[];
  onChanged: (message: string, gone: boolean) => void;
}) {
  const [contact, setContact] = useState<ContactDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setContact(await contactsApi.get(addressBookId, name));
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError && caught.status === 404 ? 'This contact no longer exists.' : describeError(caught));
    }
  }, [addressBookId, name]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error !== null && contact === null) {
    return (
      <Alert tone="danger" title="Could not open the contact">
        {error}
      </Alert>
    );
  }
  if (contact === null) return <Skeleton variant="block" />;

  if (editing) {
    return (
      <ContactEditor
        books={books}
        existing={contact}
        onCancel={() => {
          setEditing(false);
        }}
        onSaved={(_saved, message) => {
          setEditing(false);
          void load();
          onChanged(message, false);
        }}
      />
    );
  }

  const remove = () => {
    setBusy(true);
    contactsApi
      .remove(contact.addressBookId, contact.name, contact.etag)
      .then(() => {
        setConfirm(false);
        onChanged(`Deleted ${contact.displayName === '' ? 'the contact' : contact.displayName}.`, true);
      })
      .catch((caught: unknown) => {
        setConfirm(false);
        setError(caught instanceof ApiError && caught.status === 412 ? 'It was changed somewhere else first; here is the latest.' : describeError(caught));
        void load();
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const book = books.find((b) => b.id === contact.addressBookId);
  return (
    <Section
      title={contact.displayName === '' ? 'No name' : contact.displayName}
      actions={
        <Cluster gap="8">
          <Button
            size="sm"
            onClick={() => {
              setEditing(true);
            }}
          >
            Edit
          </Button>
          <Button
            size="sm"
            variant="danger-ghost"
            onClick={() => {
              setConfirm(true);
            }}
          >
            Delete
          </Button>
        </Cluster>
      }
    >
      <Stack gap="16">
        {error === null ? null : (
          <Alert tone="warning" dynamic>
            {error}
          </Alert>
        )}
        <DescriptionList>
          {contact.org === '' ? null : <DescriptionItem term="Organisation">{contact.org}</DescriptionItem>}
          {contact.emails.map((e, i) => (
            <DescriptionItem key={`e${String(i)}`} term={e.type === null ? 'E-mail' : `E-mail (${e.type})`}>
              <a href={`mailto:${e.address}`}>{e.address}</a>
            </DescriptionItem>
          ))}
          {contact.tels.map((t, i) => (
            <DescriptionItem key={`t${String(i)}`} term={t.type === null ? 'Phone' : `Phone (${t.type})`}>
              {t.value}
            </DescriptionItem>
          ))}
          {contact.note === '' ? null : (
            <DescriptionItem term="Notes">
              <span className="pr-contacts__note">{contact.note}</span>
            </DescriptionItem>
          )}
          <DescriptionItem term="Address book">{book?.displayName ?? ''}</DescriptionItem>
          {contact.hasPhoto ? <DescriptionItem term="Photo">Kept as your phone set it</DescriptionItem> : null}
        </DescriptionList>
      </Stack>
      <Modal
        open={confirm}
        onOpenChange={setConfirm}
        destructive
        title="Delete this contact?"
        description="It is removed from every device that syncs this address book."
        footer={
          <>
            <ModalClose>
              <Button type="button">Cancel</Button>
            </ModalClose>
            <Button type="button" variant="danger" loading={busy} onClick={remove}>
              Delete
            </Button>
          </>
        }
      >
        {null}
      </Modal>
    </Section>
  );
}

function ContactEditor({
  books,
  existing,
  onCancel,
  onSaved,
}: {
  books: AddressBook[];
  existing: ContactDetail | null;
  onCancel: () => void;
  onSaved: (saved: { addressBookId: string; name: string }, message: string) => void;
}) {
  const [form, setForm] = useState<ContactForm>(() => (existing === null ? blankContact() : toForm(existing)));
  const [bookId, setBookId] = useState(existing?.addressBookId ?? books.find((b) => b.slug === 'contacts')?.id ?? books[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (patch: Partial<ContactForm>) => {
    setForm((f) => ({ ...f, ...patch }));
  };

  const save = (event: SyntheticEvent) => {
    event.preventDefault();
    const problem = contactProblem(form);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setError(null);
    setBusy(true);
    const input: ContactInput = inputOf(form);
    const request = existing === null ? contactsApi.create(bookId, input) : contactsApi.update(existing.addressBookId, existing.name, existing.etag, input);
    request
      .then((saved) => {
        onSaved(saved, existing === null ? 'Contact added.' : 'Saved.');
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError && caught.status === 412 ? 'This contact was changed somewhere else (on your phone, perhaps). Cancel to see the latest.' : describeError(caught));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Section title={existing === null ? 'New contact' : `Edit ${existing.displayName === '' ? 'contact' : existing.displayName}`}>
      <form onSubmit={save} noValidate>
        <Stack gap="16">
          {error === null ? null : (
            <Alert tone="danger" dynamic>
              {error}
            </Alert>
          )}
          <Cluster gap="12">
            <FormField label="First name" width="sm">
              <Input
                value={form.given}
                autoComplete="off"
                onChange={(e) => {
                  set({ given: e.target.value });
                }}
              />
            </FormField>
            <FormField label="Last name" width="sm">
              <Input
                value={form.family}
                autoComplete="off"
                onChange={(e) => {
                  set({ family: e.target.value });
                }}
              />
            </FormField>
          </Cluster>
          <FormField label="Display name" optional help="Shown in lists; made from the name when blank.">
            <Input
              value={form.fn}
              autoComplete="off"
              onChange={(e) => {
                set({ fn: e.target.value });
              }}
            />
          </FormField>
          <FormField label="Organisation" optional>
            <Input
              value={form.org}
              autoComplete="off"
              onChange={(e) => {
                set({ org: e.target.value });
              }}
            />
          </FormField>
          <FormField label="E-mail addresses" as="group">
            <Stack gap="8">
              {form.emails.map((e, i) => (
                <Cluster key={e.key} gap="8" align="center">
                  <Input
                    type="email"
                    aria-label={`E-mail ${String(i + 1)}`}
                    value={e.address}
                    autoComplete="off"
                    onChange={(ev) => {
                      set({ emails: form.emails.map((x) => (x.key === e.key ? { ...x, address: ev.target.value } : x)) });
                    }}
                  />
                  <Select
                    aria-label={`E-mail ${String(i + 1)} type`}
                    options={typeOptions(EMAIL_TYPES, e.type)}
                    value={e.type}
                    onValueChange={(v) => {
                      set({ emails: form.emails.map((x) => (x.key === e.key ? { ...x, type: v } : x)) });
                    }}
                  />
                  <IconButton
                    icon={<RemoveIcon />}
                    label={`Remove e-mail ${String(i + 1)}`}
                    size="sm"
                    onClick={() => {
                      set({ emails: form.emails.filter((x) => x.key !== e.key) });
                    }}
                  />
                </Cluster>
              ))}
              <div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    set({ emails: [...form.emails, { key: rowKey(), address: '', type: 'none' }] });
                  }}
                >
                  Add e-mail
                </Button>
              </div>
            </Stack>
          </FormField>
          <FormField label="Phone numbers" as="group">
            <Stack gap="8">
              {form.tels.map((t, i) => (
                <Cluster key={t.key} gap="8" align="center">
                  <Input
                    type="tel"
                    aria-label={`Phone ${String(i + 1)}`}
                    value={t.value}
                    autoComplete="off"
                    onChange={(ev) => {
                      set({ tels: form.tels.map((x) => (x.key === t.key ? { ...x, value: ev.target.value } : x)) });
                    }}
                  />
                  <Select
                    aria-label={`Phone ${String(i + 1)} type`}
                    options={typeOptions(TEL_TYPES, t.type)}
                    value={t.type}
                    onValueChange={(v) => {
                      set({ tels: form.tels.map((x) => (x.key === t.key ? { ...x, type: v } : x)) });
                    }}
                  />
                  <IconButton
                    icon={<RemoveIcon />}
                    label={`Remove phone ${String(i + 1)}`}
                    size="sm"
                    onClick={() => {
                      set({ tels: form.tels.filter((x) => x.key !== t.key) });
                    }}
                  />
                </Cluster>
              ))}
              <div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    set({ tels: [...form.tels, { key: rowKey(), value: '', type: 'cell' }] });
                  }}
                >
                  Add phone
                </Button>
              </div>
            </Stack>
          </FormField>
          <FormField label="Notes" optional>
            <Textarea
              rows={3}
              value={form.note}
              onChange={(e) => {
                set({ note: e.target.value });
              }}
            />
          </FormField>
          {existing === null && books.length > 1 ? (
            <FormField label="Address book" width="md">
              <Select options={books.map((b) => ({ value: b.id, label: b.displayName }))} value={bookId} onValueChange={setBookId} />
            </FormField>
          ) : null}
          <FormActions>
            <Button type="submit" variant="primary" loading={busy}>
              Save
            </Button>
            <Button type="button" onClick={onCancel}>
              Cancel
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Section>
  );
}
