// The sorting buckets (PST-REQ-101) and which mailbox is which bucket. One definition, shared by
// the IMAP server and the webmail API (which record a training event when a user moves a message
// between two buckets, PST-REQ-104), the worker's training consumer, and the bucket folders
// PST-T-5.1 creates.
//
// INBOX holds Priority and People (the rule pass decides those); every other bucket is a real IMAP
// folder, so a move from any client is a move between buckets. Junk is the special-use \Junk
// mailbox whatever it is called; the rest are matched by their exact folder name.

export const SORT_BUCKETS = ['inbox', 'newsletters', 'updates', 'receipts', 'notifications', 'junk'] as const;

export type SortBucket = (typeof SORT_BUCKETS)[number];

/** The folder name of each bucket that is matched by name (INBOX and Junk are matched by special use). */
export const BUCKET_FOLDERS = {
  newsletters: 'Newsletters',
  updates: 'Updates',
  receipts: 'Receipts',
  notifications: 'Notifications',
} as const satisfies Partial<Record<SortBucket, string>>;

export interface MailboxLike {
  readonly name: string;
  /** The special-use attribute as the database spells it ('inbox', 'junk', ...), or null. */
  readonly specialUse: string | null;
}

const BY_NAME: ReadonlyMap<string, SortBucket> = new Map(
  (Object.entries(BUCKET_FOLDERS) as [SortBucket, string][]).map(([bucket, name]) => [name, bucket]),
);

export function isSortBucket(value: string): value is SortBucket {
  return (SORT_BUCKETS as readonly string[]).includes(value);
}

/** The bucket a mailbox is, or null when it is not a bucket (Sent, Trash, Archive, a user folder, ...). */
export function bucketOfMailbox(mailbox: MailboxLike): SortBucket | null {
  if (mailbox.specialUse === 'inbox' || mailbox.name.toUpperCase() === 'INBOX') return 'inbox';
  if (mailbox.specialUse === 'junk') return 'junk';
  // A special-use mailbox other than INBOX/Junk is never a bucket, whatever its name.
  if (mailbox.specialUse !== null) return null;
  return BY_NAME.get(mailbox.name) ?? null;
}

export interface TrainingMove {
  readonly fromBucket: SortBucket;
  readonly toBucket: SortBucket;
}

/**
 * A move is a training event (PST-REQ-104) when both mailboxes are buckets and they differ: the
 * user said "this belongs in toBucket, not fromBucket". Any other move (to Trash, to Archive,
 * between two user folders) teaches nothing, and returns null.
 */
export function trainingMove(from: MailboxLike, to: MailboxLike): TrainingMove | null {
  const fromBucket = bucketOfMailbox(from);
  const toBucket = bucketOfMailbox(to);
  if (fromBucket === null || toBucket === null || fromBucket === toBucket) return null;
  return { fromBucket, toBucket };
}
