import { type SyntheticEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Button, FormField, Input, Modal, ModalClose, Page, PageHeader, Section, TabPanel, Tabs } from '@d3cloud/ui';
import { ApiError, api, describeError } from '../api';
import { deviceApi, type MailSettings } from './device/api';
import { IphonePanel, MacPanel, OtherPanel, ThunderbirdPanel, type WithStepUp } from './device/Panels';
import { SubNav } from './SubNav';

type Client = 'iphone' | 'mac' | 'thunderbird' | 'other';

const CLIENTS: { value: Client; label: string }[] = [
  { value: 'iphone', label: 'iPhone' },
  { value: 'mac', label: 'Mac' },
  { value: 'thunderbird', label: 'Thunderbird' },
  { value: 'other', label: 'Other' },
];

interface Pending {
  action: () => Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

/**
 * Connect a device (PST-T-16.16, PST-DA-039; PST-REQ-139): pick the client, then the shortest way
 * in for it — a QR code to a one-time profile URL for an iPhone, a profile download for a Mac,
 * Thunderbird's own autoconfig, or the server settings by hand with Copy on each. Minting a profile
 * needs a fresh step-up, the same as any other credential-minting action.
 */
export function DeviceSetup() {
  const [client, setClient] = useState<Client>('iphone');
  const [settings, setSettings] = useState<MailSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const pending = useRef<Pending | null>(null);

  useEffect(() => {
    let live = true;
    deviceApi
      .settings()
      .then((loaded) => {
        if (live) setSettings(loaded);
      })
      .catch((caught: unknown) => {
        if (live) setSettingsError(describeError(caught));
      });
    return () => {
      live = false;
    };
  }, []);

  /** Runs `action`; when it needs a step-up, asks for the code and runs it again once verified. */
  const withStepUp: WithStepUp = useCallback(
    (action) =>
      action().catch((caught: unknown) => {
        if (!(caught instanceof ApiError && caught.code === 'step_up_required')) throw caught;
        return new Promise<void>((resolve, reject) => {
          pending.current?.resolve();
          pending.current = { action, resolve, reject };
          setCode('');
          setCodeError(null);
          setStepUpOpen(true);
        });
      }),
    [],
  );

  const cancelStepUp = () => {
    setStepUpOpen(false);
    pending.current?.resolve();
    pending.current = null;
  };

  const confirmStepUp = (event: SyntheticEvent) => {
    event.preventDefault();
    setVerifying(true);
    setCodeError(null);
    api
      .stepUp(code)
      .then(() => {
        const next = pending.current;
        pending.current = null;
        setStepUpOpen(false);
        if (next !== null) void next.action().then(next.resolve, next.reject);
      })
      .catch((caught: unknown) => {
        setCode('');
        setCodeError(describeError(caught));
      })
      .finally(() => {
        setVerifying(false);
      });
  };

  return (
    // PST-T-15.6: the settings grid — a 680px column of Section cards.
    <Page width="narrow">
      <PageHeader title="Connect a device" description="Set up mail, calendars and contacts on a phone, a computer or any mail app." />
      <SubNav />

      <Section title="Which device?">
        <Tabs
          aria-label="Device"
          items={CLIENTS}
          value={client}
          onValueChange={(value) => {
            setClient(value as Client);
          }}
        >
          <TabPanel value="iphone">
            <IphonePanel withStepUp={withStepUp} />
          </TabPanel>
          <TabPanel value="mac">
            <MacPanel withStepUp={withStepUp} />
          </TabPanel>
          <TabPanel value="thunderbird">
            <ThunderbirdPanel settings={settings} />
          </TabPanel>
          <TabPanel value="other">
            <OtherPanel settings={settings} error={settingsError} />
          </TabPanel>
        </Tabs>
      </Section>

      <Modal
        open={stepUpOpen}
        onOpenChange={(open) => {
          if (!open) cancelStepUp();
        }}
        title="Confirm it is you"
        description="Setting up a device mints a new app password, so it needs a code from your authenticator."
        footer={
          <>
            <ModalClose>
              <Button type="button">Cancel</Button>
            </ModalClose>
            <Button type="submit" form="device-setup-step-up" variant="primary" loading={verifying}>
              Verify
            </Button>
          </>
        }
      >
        <form id="device-setup-step-up" onSubmit={confirmStepUp}>
          <FormField label="Authentication code" {...(codeError === null ? {} : { error: codeError })}>
            <Input
              appearance="filled"
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
