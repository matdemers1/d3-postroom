import { Modal } from '@d3cloud/ui';
import { SHORTCUTS } from './keys';

/** The ? overlay (PST-REQ-084), generated from the same table the key handler reads. */
export function ShortcutsOverlay({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Keyboard shortcuts" description="They work anywhere in Mail except while you are typing.">
      <table className="pr-shortcuts">
        <caption className="pr-vh">Keyboard shortcuts</caption>
        <thead>
          <tr>
            <th scope="col">Key</th>
            <th scope="col">Does</th>
          </tr>
        </thead>
        <tbody>
          {SHORTCUTS.map((s) => (
            <tr key={s.action}>
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
