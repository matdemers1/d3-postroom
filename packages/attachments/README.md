# @postroom/attachments

Dangerous-attachment policy (PST-REQ-065). Sniffs an attachment's actual bytes — never trusts its
filename or declared `Content-Type` — and quarantines the ones that match a documented format
signature, then states which one.

No file-type or archive library is used anywhere in this package: every detector below reads a
documented magic number, header field or directory structure by hand.

## API

```ts
import { inspectAttachment } from '@postroom/attachments';
inspectAttachment({ filename, contentType, bytes, size }): { verdict, kind, reasons, findings }
```

Pure, synchronous, content-only. `verdict` is computed as the worst case — as if the sender had no
prior history. Never throws.

```ts
import { attachmentPolicy } from '@postroom/attachments';
await attachmentPolicy(collected, { senderHasHistory, openPart, maxInspectBytes? })
  : { quarantine, findings: [{ partId, filename, verdict, kind, reasons }] }
```

The worker-facing entry point. `collected` is `@postroom/mime`'s `collectMessage()` output (only
`attachments` is read). For each attachment it:

1. Runs `inspectAttachment` on the 512 sniffing bytes `collectMessage` already kept.
2. If the shallow bytes suggest a container that needs its whole content to say anything definite
   (a ZIP/OLE compound file, an ISO/IMG by extension, a declared PDF or RTF), and the attachment's
   decoded size is within `maxInspectBytes` (default 25 MiB), fetches the full part via
   `openPart(partId)` — capped: reading stops and the stream is destroyed the moment the cap would
   be exceeded, so nothing beyond the cap is ever buffered.
3. If the attachment is already known (from its declared size) to exceed the cap, it is never read
   at all and is reported as `uninspectable-archive`.
4. Applies the sender-history rule (below) to the content findings to produce each attachment's
   final verdict.

## The sender-history rule

> Executables, scripts, `.lnk` shortcuts, disc images (.iso/.img) and suspicious filenames
> (right-to-left override, a double extension ending in a dangerous one, or content that
> contradicts the declared extension) are **always quarantined**, regardless of sender history —
> these have no legitimate reason to arrive as mail from anyone.
>
> Macro-bearing documents (OLE VBA storage, OOXML `vbaProject.bin`), archives that hide their
> contents (password-protected, nested, or too large to inspect within the cap) and documents with
> active-content markers (PDF `/JavaScript`/`/Launch`/`/EmbeddedFile`, RTF `\objdata`/`\objupdate`)
> are quarantined **only for a sender without prior history**. A known sender's invoice-as-a-macro
> is unusual but not unprecedented; a stranger's is not worth the risk.
>
> An executable found *inside* an archive (by extension, or by decompressing the entry and sniffing
> its own magic bytes) is always quarantined, on the same reasoning as a bare executable — nesting
> it inside an archive is exactly the disguise the always-quarantine rule exists to defeat.

Every `Finding` carries its own `severity: 'always' | 'no-history'`, and `attachmentPolicy` applies
the rule per-attachment; `inspectAttachment`'s own `verdict` is always the no-history (worst) case,
so a caller who only wants the content findings never has to guess what would happen for an
unknown sender.

## Detectors

Magic-byte: PE/MZ, ELF, Mach-O (all four byte-order/bitness variants, plus fat binaries), the
Windows `.lnk` header, ISO 9660 (`CD001` at offset `0x8001`), OLE2/CFB compound documents
(`D0CF11E0`), ZIP local/central-directory signatures, RAR, 7z, gzip, POSIX `ustar` tar, MSCF (CAB),
`%PDF`, `{\rtf`.

Structural: a hand-rolled ZIP central-directory walker (`src/zip.ts`) reads entry names, the
per-entry encryption bit, and — for entries whose name doesn't already give it away — decompresses
just that entry to sniff its own magic bytes, to catch a nested archive or executable renamed to
look innocent. A hand-rolled OLE/CFB directory walker (`src/ole.ts`) follows the FAT sector chain to
read every stream/storage name and flags one containing `VBA`, `_VBA_PROJECT` or `Macros`.

Filename-only: a right-to-left override character (`U+202E`), and a double extension where the
final one is dangerous and the one before it looks like an ordinary document
(`invoice.pdf.exe`).

Content-vs-name: when a magic-byte detector fires on a file whose extension implies something
else entirely (a `.png` that is really an MZ executable), an extra `suspicious-filename` finding is
added alongside it.

## Not implemented

RAR and 7z are recognised by magic number only — a formal parser for either isn't attempted, so
these are reported as `uninspectable-archive` (no-history severity) rather than inspected further.
The OLE/CFB walker reads the header's own 109-entry DIFAT table but does not follow additional
DIFAT sectors, which is enough for every real Office document (they need far fewer than 109 FAT
sectors) but would miss a macro storage in a pathologically fragmented compound file.
