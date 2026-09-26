import { type SyntheticEvent, useState } from 'react';
import { Alert, Button, FormActions, FormField, Input, Modal, ModalClose, Page, PageHeader, Section, Stack } from '@d3cloud/ui';
import { ApiError, api, describeError, generateMobileconfig } from '../api';

/** Triggers a browser download of a Blob without ever navigating away from this screen. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
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

/**
 * A signed configuration profile for Mail, Calendar and Contacts (PST-REQ-139): one download sets
 * up all three on an iPhone or a Mac, with a fresh app password iOS never shows you. Generating one
 * needs a fresh step-up, the same as any other credential-minting action.
 */
export function DeviceSetup() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);

  const generate = async (): Promise<void> => {
    setError(null);
    setNotice(null);
    try {
      const { blob, filename, signed } = await generateMobileconfig();
      downloadBlob(blob, filename);
      setStepUpOpen(false);
      setNotice(
        signed
          ? 'Downloaded. Open it on the device and follow the prompts in Settings — it will show as Verified.'
          : 'Downloaded. Open it on the device and follow the prompts in Settings — it will show as Unverified (no signing certificate is configured on this server yet), but it installs and works the same.',
      );
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'step_up_required') {
        setCode('');
        setCodeError(null);
        setStepUpOpen(true);
        return;
      }
      setStepUpOpen(false);
      setError(describeError(caught));
    }
  };

  const start = (event: SyntheticEvent) => {
    event.preventDefault();
    setBusy(true);
    void generate().finally(() => {
      setBusy(false);
    });
  };

  const confirmStepUp = (event: SyntheticEvent) => {
    event.preventDefault();
    setBusy(true);
    setCodeError(null);
    api
      .stepUp(code)
      .then(() => generate())
      .catch((caught: unknown) => {
        setCode('');
        setCodeError(describeError(caught));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Page>
      <PageHeader title="Set up iPhone / Mac" description="One profile configures Mail, Calendar and Contacts together, with their own app password." />

      {notice === null ? null : (
        <Alert tone="info" dynamic>
          {notice}
        </Alert>
      )}

      <Section
        title="Download a configuration profile"
        description="Mints a fresh app password (scoped to Mail and DAV only, never your account password) and hands you back a signed .mobileconfig. On the device: open the file, then Settings > General > VPN & Device Management to install it."
      >
        <Stack gap="16">
          {error === null ? null : (
            <Alert tone="danger" title="Could not generate the profile">
              {error}
            </Alert>
          )}
          <form onSubmit={start}>
            <FormActions>
              <Button type="submit" variant="primary" loading={busy && !stepUpOpen}>
                Download profile
              </Button>
            </FormActions>
          </form>
        </Stack>
      </Section>

      <Modal
        open={stepUpOpen}
        onOpenChange={(open) => {
          if (!open) setStepUpOpen(false);
        }}
        title="Confirm it is you"
        description="Generating a device profile mints a new credential; it needs a code from your authenticator, valid for five minutes."
        footer={
          <>
            <ModalClose>
              <Button type="button">Cancel</Button>
            </ModalClose>
            <Button type="submit" form="device-setup-step-up" variant="primary" loading={busy}>
              Verify and download
            </Button>
          </>
        }
      >
        <form id="device-setup-step-up" onSubmit={confirmStepUp}>
          <FormField label="Authentication code" {...(codeError === null ? {} : { error: codeError })}>
            <Input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]*"
              autoFocus
              required
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
              }}
            />
          </FormField>
        </form>
      </Modal>
    </Page>
  );
}
