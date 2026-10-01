// The Keys screen (PST-T-12.2, PST-REQ-161): your OpenPGP keys and S/MIME certificates, and your
// contacts' public keys — what the composer signs and encrypts with, and what the Inspect drawer
// verifies against. Generate an OpenPGP key (Ed25519 + X25519), import an armored key or a PEM
// certificate (with its private key, it is yours), export either half (the private half after a
// fresh step-up), revoke your own, remove a contact's. Every change is audited on the server.
//
// PST-T-17.10: two cards, "Your keys" and "Contacts' keys". Each card's head holds its actions, and
// Generate / Import open their form in place inside that card, above its list, on the 164/360 grid —
// no always-open forms further down the page. Status is a dot and a word; a row's actions sit behind
// one ⋯ menu.
import '../settings/settings.css';
import '../screens/inline-forms.css';
import { type RefObject, type SyntheticEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  DataList,
  DataListRow,
  EmptyState,
  FormActions,
  FormField,
  IconButton,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Modal,
  ModalClose,
  Page,
  PageHeader,
  PasswordInput,
  Section,
  Select,
  Stack,
  StatusDot,
  Textarea,
} from '@d3cloud/ui';
import { ApiError, api, describeError } from '../api';
import { RelativeTime } from '../components/RelativeTime';
import { useOptionalMail } from '../mail/MailContext';
import { MoreIcon } from '../mail/thread/icons';
import { Loading, LoadFailed } from '../screens/states';
import { keysApi, type CryptoKeyJson, type RevocationReason } from './api';
import { formatFingerprint, KIND_LABEL, keyActions, keyErrorText, keyStatus, keyStatusDot, sniffImport, sortKeys, type KeyAction } from './format';

const REASONS: { value: RevocationReason; label: string }[] = [
  { value: 'none', label: 'No reason given' },
  { value: 'superseded', label: 'Replaced by a new key' },
  { value: 'retired', label: 'No longer used' },
  { value: 'compromised', label: 'Compromised (lost or stolen)' },
];

/** Which form is open, and in which card: one at a time, so the page never holds two Address fields. */
type OpenForm = { kind: 'generate' } | { kind: 'import'; card: 'own' | 'contacts' } | null;

/** The head button each open form came from, so closing it hands focus back there. */
type Opener = 'generate' | 'import-own' | 'import-contacts';

function download(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

function KeyStatusDot({ keyRow }: { keyRow: CryptoKeyJson }) {
  const dot = keyStatusDot(keyStatus(keyRow));
  return (
    <StatusDot size="sm" tone={dot.tone}>
      {dot.label}
    </StatusDot>
  );
}

export function Keys() {
  const mail = useOptionalMail();
  const [rows, setRows] = useState<CryptoKeyJson[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [notice, setNotice] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);

  const [open, setOpen] = useState<OpenForm>(null);
  // The head buttons unmount while their form is open; closing it (Cancel, or done) hands focus back
  // to the one that opened it, as Account's Change password does (PST-T-16.23).
  const generateButton = useRef<HTMLButtonElement>(null);
  const importOwnButton = useRef<HTMLButtonElement>(null);
  const importContactsButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<Opener | null>(null);
  useEffect(() => {
    if (open !== null || returnFocus.current === null) return;
    const refs: Record<Opener, RefObject<HTMLButtonElement | null>> = { generate: generateButton, 'import-own': importOwnButton, 'import-contacts': importContactsButton };
    refs[returnFocus.current].current?.focus();
    returnFocus.current = null;
  }, [open]);

  const [genAddress, setGenAddress] = useState(mail?.me ?? '');
  const [genName, setGenName] = useState('');
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  const [importText, setImportText] = useState('');
  const [importKey, setImportKey] = useState('');
  const [importPass, setImportPass] = useState('');
  const [importAddress, setImportAddress] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const [revoking, setRevoking] = useState<CryptoKeyJson | null>(null);
  const [reason, setReason] = useState<RevocationReason>('none');

  const [exporting, setExporting] = useState<CryptoKeyJson | null>(null);
  const [exportPass, setExportPass] = useState('');
  const [stepUp, setStepUp] = useState(false);
  const [code, setCode] = useState('');
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(sortKeys((await keysApi.list()).keys));
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (genAddress === '' && mail?.me !== null && mail?.me !== undefined) setGenAddress(mail.me);
  }, [mail?.me, genAddress]);

  const openForm = (form: Exclude<OpenForm, null>) => {
    setNotice(null);
    setGenError(null);
    setImportError(null);
    setOpen(form);
  };

  const closeForm = () => {
    if (open !== null) returnFocus.current = open.kind === 'generate' ? 'generate' : open.card === 'own' ? 'import-own' : 'import-contacts';
    setOpen(null);
    setGenName('');
    setGenError(null);
    setImportText('');
    setImportKey('');
    setImportPass('');
    setImportAddress('');
    setImportError(null);
  };

  const generate = (event: SyntheticEvent) => {
    event.preventDefault();
    setNotice(null);
    setGenError(null);
    setGenBusy(true);
    keysApi
      .generate(genAddress.trim(), genName.trim())
      .then(async ({ key }) => {
        setNotice({ tone: 'info', text: `Generated an OpenPGP key for ${key.address}: ${formatFingerprint(key.fingerprint)}. Export the public key and share it so people can encrypt to you.` });
        closeForm();
        await load();
      })
      .catch((caught: unknown) => {
        setGenError(keyErrorText(caught));
      })
      .finally(() => {
        setGenBusy(false);
      });
  };

  const kindOfImport = sniffImport(importText);

  const doImport = (event: SyntheticEvent) => {
    event.preventDefault();
    setImportError(null);
    setNotice(null);
    const pass = importPass === '' ? {} : { passphrase: importPass };
    const address = importAddress.trim() === '' ? {} : { address: importAddress.trim() };
    let input: Parameters<typeof keysApi.import>[0];
    if (kindOfImport === 'certificate') input = { kind: 'smime', certificate: importText, ...(importKey.trim() === '' ? {} : { privateKey: importKey }), ...pass, ...address };
    else if (kindOfImport === 'pgp-public' || kindOfImport === 'pgp-secret') input = { kind: 'pgp', armored: importText, ...pass, ...address };
    else {
      setImportError('Paste an armored OpenPGP key (BEGIN PGP PUBLIC KEY BLOCK or PRIVATE KEY BLOCK) or a PEM certificate (BEGIN CERTIFICATE).');
      return;
    }
    setImportBusy(true);
    keysApi
      .import(input)
      .then(async ({ key }) => {
        setNotice({ tone: 'info', text: `Imported ${key.owner === 'own' ? 'your' : 'a contact’s'} ${KIND_LABEL[key.kind]} key for ${key.address}.` });
        closeForm();
        await load();
      })
      .catch((caught: unknown) => {
        setImportError(keyErrorText(caught));
      })
      .finally(() => {
        setImportBusy(false);
      });
  };

  const exportPublic = (row: CryptoKeyJson) => {
    keysApi
      .exportPublic(row.id)
      .then((out) => {
        download(out.publicKey, out.filename);
      })
      .catch((caught: unknown) => {
        setNotice({ tone: 'danger', text: keyErrorText(caught) });
      });
  };

  const runExportSecret = async (row: CryptoKeyJson): Promise<void> => {
    setExportError(null);
    try {
      const out = await keysApi.exportSecret(row.id, exportPass);
      download(out.secret, out.filename);
      setExporting(null);
      setStepUp(false);
      setNotice({ tone: 'info', text: out.protected ? 'Downloaded your private key, protected with your passphrase.' : 'Downloaded your private key, unprotected. Keep the file somewhere safe.' });
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'step_up_required') {
        setCode('');
        setStepUp(true);
        return;
      }
      setExportError(keyErrorText(caught));
    }
  };

  const confirmExport = (event: SyntheticEvent) => {
    event.preventDefault();
    if (exporting === null) return;
    const row = exporting;
    setExportBusy(true);
    const run = stepUp ? api.stepUp(code).then(() => runExportSecret(row)) : runExportSecret(row);
    run
      .catch((caught: unknown) => {
        setCode('');
        setExportError(describeError(caught));
      })
      .finally(() => {
        setExportBusy(false);
      });
  };

  const confirmRevoke = () => {
    if (revoking === null) return;
    const row = revoking;
    keysApi
      .revoke(row.id, reason)
      .then(async () => {
        setRevoking(null);
        setNotice({ tone: 'info', text: `Revoked the key for ${row.address}. ${row.kind === 'pgp' && row.owner === 'own' ? 'Export the public key again and share it, so others learn it is revoked.' : ''}`.trim() });
        await load();
      })
      .catch((caught: unknown) => {
        setRevoking(null);
        setNotice({ tone: 'danger', text: keyErrorText(caught) });
      });
  };

  const remove = (row: CryptoKeyJson) => {
    keysApi
      .remove(row.id)
      .then(async () => {
        setNotice({ tone: 'info', text: `Removed the key for ${row.address}.` });
        await load();
      })
      .catch((caught: unknown) => {
        setNotice({ tone: 'danger', text: keyErrorText(caught) });
      });
  };

  const runAction = (action: KeyAction, k: CryptoKeyJson) => {
    setNotice(null);
    if (action === 'export-public') exportPublic(k);
    else if (action === 'export-private') {
      setExportPass('');
      setExportError(null);
      setStepUp(false);
      setExporting(k);
    } else if (action === 'revoke') {
      setReason('none');
      setRevoking(k);
    } else remove(k);
  };

  // PST-T-15.6: a key is a row — address, what it is and its fingerprint, its status, its actions —
  // rather than a seven-column table squeezed into the 680px settings column.
  const keyRow = (k: CryptoKeyJson) => (
    <DataListRow
      key={k.id}
      truncate={false}
      title={k.address}
      description={
        <>
          {`${KIND_LABEL[k.kind]} · ${k.algorithm} · added `}
          <RelativeTime iso={k.createdAt} />
          <code className="pr-key-fpr">{formatFingerprint(k.fingerprint)}</code>
        </>
      }
      meta={<KeyStatusDot keyRow={k} />}
      actions={
        <Menu>
          <MenuTrigger>
            <IconButton size="sm" variant="ghost" label={`Actions for the ${KIND_LABEL[k.kind]} key for ${k.address}`} icon={<MoreIcon />} />
          </MenuTrigger>
          <MenuContent align="end">
            {keyActions(k).map((item) => (
              <MenuItem
                key={item.action}
                onSelect={() => {
                  runAction(item.action, k);
                }}
              >
                {item.label}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      }
    />
  );

  const generateForm = (
    <form className="pr-setform pr-inline-form" aria-labelledby="keys-generate" onSubmit={generate}>
      <div className="pr-inline-form__head">
        <h3 id="keys-generate" className="pr-inline-form__title">
          Generate an OpenPGP key
        </h3>
        <p className="pr-inline-form__desc">Ed25519 for signing, X25519 for encryption. The private half stays sealed on the server.</p>
      </div>
      <FormField label="Address" width="lg" help="One of your own addresses." {...(genError === null ? {} : { error: genError })}>
        <Input appearance="filled" autoFocus name="address" type="email" required value={genAddress} onChange={(e) => { setGenAddress(e.target.value); }} />
      </FormField>
      <FormField label="Name" width="lg" optional help="Shown in the key’s user ID. Defaults to your display name.">
        <Input appearance="filled" name="name" maxLength={200} value={genName} onChange={(e) => { setGenName(e.target.value); }} />
      </FormField>
      <FormActions className="pr-setform__actions">
        <Button type="button" onClick={closeForm}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={genBusy}>
          Generate key
        </Button>
      </FormActions>
    </form>
  );

  const importForm = (card: 'own' | 'contacts') => (
    <form className="pr-setform pr-inline-form" aria-labelledby="keys-import" onSubmit={doImport}>
      <div className="pr-inline-form__head">
        <h3 id="keys-import" className="pr-inline-form__title">
          {card === 'own' ? 'Import your key' : 'Import a contact’s key'}
        </h3>
        <p className="pr-inline-form__desc">
          {card === 'own' ? 'An OpenPGP secret key, or an S/MIME certificate with its private key.' : 'Their OpenPGP public key or S/MIME certificate.'}
        </p>
      </div>
      <FormField label="Key or certificate" width="lg" help="An armored OpenPGP key block, or a PEM certificate with any intermediates after it." {...(importError === null ? {} : { error: importError })}>
        <Textarea appearance="filled" mono autoFocus rows={6} value={importText} onChange={(e) => { setImportText(e.target.value); }} />
      </FormField>
      {kindOfImport === 'certificate' ? (
        <FormField label="Private key" width="lg" optional help="PEM PKCS#8. With it, the certificate is yours: you can sign with it and open mail encrypted to it.">
          <Textarea appearance="filled" mono rows={4} value={importKey} onChange={(e) => { setImportKey(e.target.value); }} />
        </FormField>
      ) : null}
      {kindOfImport === 'pgp-secret' || (kindOfImport === 'certificate' && importKey.trim() !== '') ? (
        <FormField label="Passphrase" width="lg" optional help="If the private key is protected. Postroom stores it sealed instead, without the passphrase.">
          <PasswordInput value={importPass} autoComplete="off" onChange={(e) => { setImportPass(e.target.value); }} />
        </FormField>
      ) : null}
      <FormField label="Address" width="lg" optional help="Which of the key’s addresses this is for, when it has several.">
        <Input appearance="filled" value={importAddress} type="email" onChange={(e) => { setImportAddress(e.target.value); }} />
      </FormField>
      <FormActions className="pr-setform__actions">
        <Button type="button" onClick={closeForm}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={importBusy}>
          Import
        </Button>
      </FormActions>
    </form>
  );

  const own = rows?.filter((k) => k.owner === 'own') ?? [];
  const contacts = rows?.filter((k) => k.owner === 'contact') ?? [];
  const ownFormOpen = open !== null && (open.kind === 'generate' || open.card === 'own');
  const contactsFormOpen = open?.kind === 'import' && open.card === 'contacts';

  return (
    // PST-T-15.6: the settings grid — a 680px column of Section cards, centred (PST-T-17.10).
    <Page width="narrow" align="center">
      <PageHeader
        title="Encryption keys"
        description="OpenPGP keys and S/MIME certificates for signing and encrypting mail."
        {...(rows === null || rows.length === 0 ? {} : { count: rows.length, countNoun: { one: 'key', other: 'keys' } })}
      />
      {notice === null ? null : (
        <Alert tone={notice.tone} dynamic>
          {notice.text}
        </Alert>
      )}

      {loadError !== null ? (
        <LoadFailed error={loadError} what="keys" onRetry={() => void load()} />
      ) : rows === null ? (
        <Loading label="Loading keys" />
      ) : (
        <Stack gap="24">
          <Section
            title="Your keys"
            description="Sign what you send; open mail encrypted to you."
            actions={
              ownFormOpen ? null : (
                <>
                  <Button ref={importOwnButton} size="sm" onClick={() => { openForm({ kind: 'import', card: 'own' }); }}>
                    Import
                  </Button>
                  <Button ref={generateButton} size="sm" variant="primary" onClick={() => { openForm({ kind: 'generate' }); }}>
                    Generate a key
                  </Button>
                </>
              )
            }
          >
            {open?.kind === 'generate' ? generateForm : null}
            {open?.kind === 'import' && open.card === 'own' ? importForm('own') : null}
            {own.length === 0 ? (
              ownFormOpen ? null : (
                <EmptyState kind="empty" heading="No keys of your own yet" headingLevel={3} size="row">
                  Generate one, or import a key you already have.
                </EmptyState>
              )
            ) : (
              <DataList aria-label="Your keys">{own.map((k) => keyRow(k))}</DataList>
            )}
          </Section>
          <Section
            title="Contacts’ keys"
            description="Encrypt to these addresses; verify their signatures."
            actions={
              contactsFormOpen ? null : (
                <Button ref={importContactsButton} size="sm" onClick={() => { openForm({ kind: 'import', card: 'contacts' }); }}>
                  Import a key
                </Button>
              )
            }
          >
            {contactsFormOpen ? importForm('contacts') : null}
            {contacts.length === 0 ? (
              contactsFormOpen ? null : (
                <EmptyState kind="empty" heading="No contacts’ keys yet" headingLevel={3} size="row">
                  One appears when you import it or receive signed mail.
                </EmptyState>
              )
            ) : (
              <DataList aria-label="Contacts’ keys">{contacts.map((k) => keyRow(k))}</DataList>
            )}
          </Section>
        </Stack>
      )}

      <Modal
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={revoking?.owner === 'own' ? 'Revoke this key?' : 'Mark this key revoked?'}
        description={
          revoking?.owner === 'own'
            ? 'Nothing it signed is trusted afterwards, and mail is no longer encrypted to it. It stays, so mail already encrypted to it still opens.'
            : 'Mail is no longer encrypted to it, and nothing it signed is trusted.'
        }
        footer={
          <>
            <ModalClose>
              <Button type="button">Cancel</Button>
            </ModalClose>
            <Button type="button" variant="danger" onClick={confirmRevoke}>
              Revoke
            </Button>
          </>
        }
      >
        {revoking?.owner === 'own' && revoking.kind === 'pgp' ? (
          <FormField label="Reason" help="Written into the revocation others receive with your key.">
            <Select appearance="filled" options={REASONS} value={reason} onValueChange={(v) => { setReason((REASONS.find((r) => r.value === v) ?? { value: 'none' as const }).value); }} />
          </FormField>
        ) : null}
      </Modal>

      <Modal
        open={exporting !== null}
        onOpenChange={(open) => {
          if (!open) setExporting(null);
        }}
        title={stepUp ? 'Confirm it is you' : 'Export your private key'}
        description={stepUp ? 'Exporting a private key needs a code from your authenticator, valid for five minutes.' : 'Anyone with this file can read mail sent to you and sign as you. Protect it with a passphrase.'}
        footer={
          <>
            <ModalClose>
              <Button type="button">Cancel</Button>
            </ModalClose>
            <Button type="submit" form="keys-export-secret" variant="primary" loading={exportBusy}>
              {stepUp ? 'Verify and download' : 'Download'}
            </Button>
          </>
        }
      >
        <form id="keys-export-secret" onSubmit={confirmExport}>
          <Stack gap="12">
            {exportError === null ? null : (
              <Alert tone="danger" dynamic>
                {exportError}
              </Alert>
            )}
            {stepUp ? (
              <FormField label="Authentication code">
                <Input appearance="filled" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" autoFocus required value={code} onChange={(e) => { setCode(e.target.value); }} />
              </FormField>
            ) : (
              <FormField label="Passphrase" optional help="At least 8 characters. Leave it empty for an unprotected file.">
                <PasswordInput value={exportPass} autoComplete="new-password" onChange={(e) => { setExportPass(e.target.value); }} />
              </FormField>
            )}
          </Stack>
        </form>
      </Modal>
    </Page>
  );
}
