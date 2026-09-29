// Sign / Encrypt (PST-T-12.2, PST-REQ-161), moved out of the composer's form into a dialog behind ⋯
// (PST-T-14.7; design audit CPY-04, TF-06): a rare option, one click away, never in the way. The
// rules — which kind, what is available, why not — are keys/format.ts's, unchanged.
import { Button, Checkbox, FormField, Modal, ModalClose, Select, Stack } from '@d3cloud/ui';
import type { KeyKind } from '../../keys/api';
import { KIND_LABEL, type cryptoAvailability } from '../../keys/format';

export interface SecurityModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null while the account's keys are still loading. */
  loaded: boolean;
  kind: KeyKind;
  onKind: (kind: KeyKind) => void;
  sign: boolean;
  onSign: (on: boolean) => void;
  encrypt: boolean;
  onEncrypt: (on: boolean) => void;
  availability: ReturnType<typeof cryptoAvailability>;
}

export function SecurityModal({ open, onOpenChange, loaded, kind, onKind, sign, onSign, encrypt, onEncrypt, availability }: SecurityModalProps) {
  const reasons = [sign || availability.sign.available ? null : availability.sign.reason, availability.encrypt.available ? null : availability.encrypt.reason].filter(
    (r): r is string => r !== null,
  );
  const help = !loaded
    ? 'Checking your keys…'
    : reasons.join(' ') || `Headers, including the subject, are not encrypted. Encrypted mail is also encrypted to your own ${KIND_LABEL[kind]} key.`;
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Sign or encrypt"
      description="Signing proves the message came from you. Encrypting means only the recipients can read it."
      footer={
        <ModalClose>
          <Button variant="primary">Done</Button>
        </ModalClose>
      }
    >
      <FormField label="Keys" as="group" help={help}>
        <Stack gap="8">
          <Select
            appearance="filled"
            aria-label="Key kind"
            options={[
              { value: 'pgp', label: 'OpenPGP (PGP/MIME)' },
              { value: 'smime', label: 'S/MIME' },
            ]}
            value={kind}
            onValueChange={(v) => { onKind(v === 'smime' ? 'smime' : 'pgp'); }}
          />
          <Checkbox label="Sign" checked={sign} disabled={!sign && !availability.sign.available} onCheckedChange={(checked) => { onSign(checked === true); }} />
          <Checkbox
            label={availability.encrypt.missing.length > 0 && encrypt ? `Encrypt — no key for ${availability.encrypt.missing.join(', ')}` : 'Encrypt'}
            checked={encrypt}
            disabled={!encrypt && !availability.encrypt.available}
            onCheckedChange={(checked) => { onEncrypt(checked === true); }}
          />
        </Stack>
      </FormField>
    </Modal>
  );
}
