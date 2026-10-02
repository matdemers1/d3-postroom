// PST-T-16.13 (PST-DA-031): the four row actions as one menu. PST-T-17.1 (admin critique X9): its
// trigger is a ⋯ IconButton, named "Actions for <address>"; nothing in the row is red — Delete's
// danger lives in the menu item's tone and the confirm-and-step-up modal (PST-REQ-008), so
// selecting an item never acts by itself.
import { Button, IconButton, Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from '@d3cloud/ui';
import { type QueueActionKind, domainMenuItems, queueMenuItems } from './model';
import { MoreIcon } from './MoreIcon';

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
        <IconButton label={`Actions for ${address}`} icon={<MoreIcon />} size="sm" />
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

/**
 * Admin critique 2.2 #1: the bulk actions live with the one Domain filter. They appear only once a
 * domain is typed, as a menu at the end of the toolbar, and each opens the same confirm modal.
 */
export function DomainActions({
  domain,
  sesConfigured,
  onPick,
}: {
  domain: string;
  sesConfigured: boolean;
  onPick: (kind: QueueActionKind, confirm: string) => void;
}) {
  return (
    <Menu>
      <MenuTrigger>
        <Button size="sm" variant="secondary" className="pr-queue-bulk">
          <span className="pr-queue-bulk__text">Act on {domain}</span>
        </Button>
      </MenuTrigger>
      <MenuContent align="end">
        <MenuLabel>Up to 500 recipients per request</MenuLabel>
        {domainMenuItems(domain, sesConfigured).map((item) => (
          <MenuItem
            key={item.kind}
            tone={item.tone}
            disabled={item.disabled}
            onSelect={() => {
              onPick(item.kind, item.confirm);
            }}
          >
            {item.disabled && item.reason !== null ? `${item.label} (${item.reason.toLowerCase()})` : item.label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
