import { Button, Modal, ModalClose } from '@d3cloud/ui';
import { overlayShortcuts } from './keys';

/** The ? overlay (PST-REQ-084), generated from the same table the key handler reads. */
export function ShortcutsOverlay({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Keyboard shortcuts"
      description="Work in any mailbox, except while you’re typing in a field."
      footer={
        <ModalClose>
          <Button type="button">Close</Button>
        </ModalClose>
      }
    >
      <table className="pr-shortcuts">
        <caption className="pr-vh">Keyboard shortcuts</caption>
        <thead>
          <tr>
            <th scope="col">Key</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {overlayShortcuts().map((s) => (
            <tr key={s.id}>
              <td>
                <kbd>{s.keys}</kbd>
              </td>
              <td>{s.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
