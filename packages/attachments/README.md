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
> An executable found *inside* an archive — at any nesting depth up to the recursion limit, by
> extension or by decompressing the entry and sniffing its own magic bytes — is always quarantined,
> on the same reasoning as a bare executable — nesting it inside one or more archives is exactly the
> disguise the always-quarantine rule exists to defeat.
>
> A ZIP whose central directory is missing, corrupt, or points out of range is **always
> quarantined** as `malformed-archive`, regardless of sender history. A broken container is itself
> a strong evasion signal — real mail clients do not produce ZIPs with an unparseable directory —
> so this is treated the same as a bare executable rather than relaxed for a known sender. We still
> recover what we can via a local-file-header fallback scan (see below), so a genuinely malicious
> payload behind a corrupted directory is still named in the reasons, not just quarantined blind.

### Nested archives, recursion and decompression bombs

`inspectZip` recurses into any entry that looks like an archive (by extension or by sniffing its
decompressed content), not just the outer ZIP's own entry list — a ZIP containing a ZIP containing
an executable is found and always-quarantined, the same as a bare one. Recursion is bounded two
ways:

- **Depth**: capped at 3 nested archives. An archive nested deeper than that is reported as
  `uninspectable-archive` (no-history severity) rather than either recursed into unboundedly or
  silently ignored.
- **A shared decompression budget** (25 MiB by default, matching the outer per-attachment cap):
  every byte decompressed across the whole recursion — sniffing an entry's magic, or fully
  decompressing a nested archive to read its own central directory — is deducted from one budget.
  An archive that would need more than the remaining budget to inspect fully is reported as
  `uninspectable-archive` rather than partially trusted.

Decompression itself never allocates unboundedly regardless of what an entry claims or contains:
`readEntryBytes` feeds the compressed bytes through a persistent raw-inflate stream in small (4 KiB)
input slices, checking after every slice whether the requested output cap has been reached, and
discards the rest the moment it has — so a compressed stream that would inflate to hundreds of
megabytes never causes more than a `cap`-sized allocation. Independently, and cheaply (no
decompression required), a declared compression ratio over 100:1 or a declared uncompressed size
over 100 MiB is itself flagged as `suspicious-compression-ratio` (no-history severity) from the
central-directory metadata alone — a static check that catches an honestly-labelled bomb before we
even try to decompress it, alongside (not instead of) the bounded decompression itself, since the
declared size is attacker-controlled and cannot be the only defence.

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
just that entry (bounded; see below) to sniff its own magic bytes, to catch a nested archive or
executable renamed to look innocent, recursing into nested archives up to a depth limit. When the
central directory itself can't be trusted, it falls back to scanning local file headers directly
(bounded to 5000 entries) so a real macro or executable behind a corrupted directory is still
found. A hand-rolled OLE/CFB directory walker (`src/ole.ts`) follows the FAT sector chain to read
every stream/storage name and flags one containing `VBA`, `_VBA_PROJECT` or `Macros`.

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


## Depth limit

Nested archives are inspected to a depth of 3. Anything nested deeper is reported as
`uninspectable-archive` and **always** quarantined, whatever the sender's history: an executable
could sit below the depth we look at, and legitimate mail almost never nests archives that deep.
