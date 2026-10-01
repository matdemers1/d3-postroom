// PST-T-16.13 (PST-DA-031): the four row actions as one Actions menu. The destructive one still
// opens the screen's confirm-and-step-up modal (PST-REQ-008), so selecting it never acts by itself.
import { Button, Menu, MenuContent, MenuItem, MenuTrigger } from '@d3cloud/ui';
import { type QueueActionKind, queueMenuItems } from './model';

export function QueueActions({
  address,
  sesConfigured,
  onPick,
}: {
  address: string;
  sesConfigured: boolean;
  onPick: (kind: QueueActionKind) => void;
}) {
  return (
    <Menu>
      <MenuTrigger>
        <Button size="sm" variant="secondary" aria-label={`Actions for ${address}`}>
          Actions
        </Button>
      </MenuTrigger>
      <MenuContent align="end" aria-label={`Actions for ${address}`}>
        {queueMenuItems(sesConfigured).map((item) => (
          <MenuItem
            key={item.kind}
            tone={item.tone}
            disabled={item.disabled}
            onSelect={() => {
              onPick(item.kind);
            }}
          >
            {item.disabled && item.reason !== null ? `${item.label} (${item.reason.toLowerCase()})` : item.label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
