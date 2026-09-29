import type { ReactNode } from 'react';
import { Badge, type BadgeProps } from '@d3cloud/ui';
import { STATUS_TONE, type StatusKind } from './status';
import './status.css';

/** A Badge for a check's outcome: the tone and glyph come from STATUS_TONE, the words from the caller. */
export function StatusBadge({ kind, children, ...rest }: { kind: StatusKind; children: ReactNode } & Omit<BadgeProps, 'tone' | 'children'>) {
  return (
    <Badge {...rest} tone={STATUS_TONE[kind]} className="pr-status" data-status={kind}>
      {children}
    </Badge>
  );
}
