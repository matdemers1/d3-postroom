// The Keys screen (PST-T-12.2, PST-REQ-161): your OpenPGP keys and S/MIME certificates, and your
// contacts' public keys — what the composer signs and encrypts with, and what the Inspect drawer
// verifies against. Generate an OpenPGP key (Ed25519 + X25519), import an armored key or a PEM
// certificate (with its private key, it is yours), export either half (the private half after a
// fresh step-up), revoke your own, remove a contact's. Every change is audited on the server.
import { type SyntheticEvent, useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Cluster,
  EmptyState,
  FormActions,
  FormField,
  Input,
  Modal,
  ModalClose,
  Page,
  PageHeader,
  PasswordInput,
  Section,
  Select,
  Stack,
  Table,
  Textarea,
  type TableColumn,
} from '@d3cloud/ui';
import { ApiError, api, describeError } from '../api';
import { useOptionalMail } from '../mail/MailContext';
import { Loading, LoadFailed } from '../screens/states';
import { keysApi, type CryptoKeyJson, type RevocationReason } from './api';
import { formatFingerprint, KIND_LABEL, keyErrorText, keyStatus, sniffImport, sortKeys } from './format';

const REASONS: { value: RevocationReason; label: string }[] = [
  { value: 'none', label: 'No reason given' },
  { value: 'superseded', label: 'Replaced by a new key' },
  { value: 'retired', label: 'No longer used' },
  { value: 'compromised', label: 'Compromised (lost or stolen)' },
];

const when = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });

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

function StatusBadge({ keyRow }: { keyRow: CryptoKeyJson }) {
  const status = keyStatus(keyRow);
  if (status === 'revoked') return <Badge size="sm" tone="danger">Revoked</Badge>;
  if (status === 'expired') return <Badge size="sm" tone="attention">Expired</Badge>;
  return <Badge size="sm">Active</Badge>;
}

export function Keys() {
  const mail = useOptionalMail();
  const [rows, setRows] = useState<CryptoKeyJson[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [notice, setNotice] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);

  const [genAddress, setGenAddress] = useState(mail?.me ?? '');
  const [genName, setGenName] = useState('');
  const [genBusy, setGenBusy] = useState(false);

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

  const generate = (event: SyntheticEvent) => {
    event.preventDefault();
    setNotice(null);
    setGenBusy(true);
    keysApi
      .generate(genAddress.trim(), genName.trim())
      .then(async ({ key }) => {
        setNotice({ tone: 'info', text: `Generated an OpenPGP key for ${key.address}: ${formatFingerprint(key.fingerprint)}. Export the public key and share it so people can encrypt to you.` });
        await load();
      })
      .catch((caught: unknown) => {
        setNotice({ tone: 'danger', text: keyErrorText(caught) });
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
        setImportText('');
        setImportKey('');
        setImportPass('');
        setImportAddress('');
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

  const base: TableColumn<CryptoKeyJson>[] = [
    { key: 'address', header: 'Address', cell: (k) => k.address },
    { key: 'kind', header: 'Kind', cell: (k) => KIND_LABEL[k.kind] },
    { key: 'algorithm', header: 'Algorithm', cell: (k) => k.algorithm },
    { key: 'fingerprint', header: 'Fingerprint', cell: (k) => <code>{formatFingerprint(k.fingerprint)}</code> },
    { key: 'status', header: 'Status', cell: (k) => <StatusBadge keyRow={k} /> },
    { key: 'created', header: 'Added', cell: (k) => when(k.createdAt) },
  ];

  const ownColumns: TableColumn<CryptoKeyJson>[] = [
    ...base,
    {
      key: 'actions',
      header: 'Actions',
      align: 'end',
      cell: (k) => (
        <Cluster gap="4">
          <Button size="sm" variant="ghost" aria-label={`Export the public key for ${k.address}`} onClick={() => { exportPublic(k); }}>
            Export public
          </Button>
          {k.hasPrivate ? (
            <Button size="sm" variant="ghost" aria-label={`Export the private key for ${k.address}`} onClick={() => { setExportPass(''); setExportError(null); setStepUp(false); setExporting(k); }}>
              Export private
            </Button>
          ) : null}
          {k.revokedAt === null ? (
            <Button size="sm" variant="danger-ghost" aria-label={`Revoke the key for ${k.address}`} onClick={() => { setReason('none'); setRevoking(k); }}>
              Revoke
            </Button>
          ) : null}
        </Cluster>
      ),
    },
  ];

  const contactColumns: TableColumn<CryptoKeyJson>[] = [
    ...base,
    {
      key: 'actions',
      header: 'Actions',
      align: 'end',
      cell: (k) => (
        <Cluster gap="4">
          <Button size="sm" variant="ghost" aria-label={`Export the key for ${k.address}`} onClick={() => { exportPublic(k); }}>
            Export
          </Button>
          {k.revokedAt === null ? (
            <Button size="sm" variant="ghost" aria-label={`Mark the key for ${k.address} revoked`} onClick={() => { setReason('none'); setRevoking(k); }}>
              Mark revoked
            </Button>
          ) : null}
          <Button size="sm" variant="danger-ghost" aria-label={`Remove the key for ${k.address}`} onClick={() => { remove(k); }}>
            Remove
          </Button>
        </Cluster>
      ),
    },
  ];

  const own = rows?.filter((k) => k.owner === 'own') ?? [];
  const contacts = rows?.filter((k) => k.owner === 'contact') ?? [];

  return (
    <Page>
      <PageHeader
        title="Keys"
        description="OpenPGP keys and S/MIME certificates: yours sign and decrypt, your contacts’ are what mail to them is encrypted with."
        {...(rows === null ? {} : { count: rows.length, countNoun: { one: 'key', other: 'keys' } })}
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
          <Section title="Your keys" description="Used to sign what you send, and to open mail encrypted to you. Encrypted mail you send is always encrypted to your own key too.">
            <Table caption="Your keys" columns={ownColumns} rows={own} rowKey={(k) => k.id} empty={<EmptyState kind="empty" heading="No keys of your own yet" size="row" />} />
          </Section>
          <Section title="Contacts’ keys" description="Mail to these addresses can be encrypted; their signatures verify as a known key.">
            <Table caption="Contacts’ keys" columns={contactColumns} rows={contacts} rowKey={(k) => k.id} empty={<EmptyState kind="empty" heading="No contacts’ keys yet" size="row" />} />
          </Section>
        </Stack>
      )}

      <Section title="Generate an OpenPGP key" description="An Ed25519 signing key with an X25519 encryption subkey. The private half is kept sealed on the server.">
        <form onSubmit={generate}>
          <Stack gap="16">
            <FormField label="Address" help="One of your own addresses.">
              <Input name="address" type="email" required value={genAddress} onChange={(e) => { setGenAddress(e.target.value); }} />
            </FormField>
            <FormField label="Name" optional help="Shown in the key’s user ID; default your display name.">
              <Input name="name" maxLength={200} value={genName} onChange={(e) => { setGenName(e.target.value); }} />
            </FormField>
            <FormActions>
              <Button type="submit" variant="primary" loading={genBusy}>
                Generate key
              </Button>
            </FormActions>
          </Stack>
        </form>
      </Section>

      <Section title="Import a key" description="A contact’s public key or certificate, or your own secret key or certificate with its private key.">
        <form onSubmit={doImport}>
          <Stack gap="16">
            <FormField label="Key or certificate" help="Paste an armored OpenPGP key block, or a PEM certificate (intermediates after it)." {...(importError === null ? {} : { error: importError })}>
              <Textarea mono rows={8} value={importText} onChange={(e) => { setImportText(e.target.value); }} />
            </FormField>
            {kindOfImport === 'certificate' ? (
              <FormField label="Private key" optional help="PEM PKCS#8. With it, the certificate is yours: you can sign with it and open mail encrypted to it.">
                <Textarea mono rows={6} value={importKey} onChange={(e) => { setImportKey(e.target.value); }} />
              </FormField>
            ) : null}
            {kindOfImport === 'pgp-secret' || (kindOfImport === 'certificate' && importKey.trim() !== '') ? (
              <FormField label="Passphrase" optional help="If the private key is protected. Postroom stores it sealed instead, without the passphrase.">
                <PasswordInput value={importPass} autoComplete="off" onChange={(e) => { setImportPass(e.target.value); }} />
              </FormField>
            ) : null}
            <FormField label="Address" optional help="Which of the key’s addresses this is for, when it has several.">
              <Input value={importAddress} type="email" onChange={(e) => { setImportAddress(e.target.value); }} />
            </FormField>
            <FormActions>
              <Button type="submit" variant="primary" loading={importBusy}>
                Import
              </Button>
            </FormActions>
          </Stack>
        </form>
      </Section>

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
            <Select options={REASONS} value={reason} onValueChange={(v) => { setReason((REASONS.find((r) => r.value === v) ?? { value: 'none' as const }).value); }} />
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
                <Input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" autoFocus required value={code} onChange={(e) => { setCode(e.target.value); }} />
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
