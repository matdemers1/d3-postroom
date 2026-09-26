// PST-T-3.12: how the reading pane asks for and frames rendered HTML. The frame's sandbox never
// grants scripts or same-origin (PST-REQ-081); remote images are asked for only on request, and the
// reader is told why they are blocked (PST-REQ-082). The browser behaviour is e2e/tests/html-render.spec.ts.
import { describe, expect, it, vi } from 'vitest';
import { renderPath } from '../../src/api';

// The component library ships CSS, which Node cannot import; nothing here renders.
vi.mock('@d3cloud/ui', () => ({}));
import { blockedImagesNote, MAIL_FRAME_SANDBOX } from '../../src/mail/ReadingPane';

const ID = '22222222-2222-4222-8222-222222222222';

describe('the mail frame', () => {
  it('is sandboxed without scripts or same-origin', () => {
    const tokens = MAIL_FRAME_SANDBOX.split(/\s+/);
    expect(tokens).not.toContain('allow-scripts');
    expect(tokens).not.toContain('allow-same-origin');
    expect(tokens).not.toContain('allow-top-navigation');
    expect(tokens).not.toContain('allow-forms');
  });

  it('asks for remote images only when the reader chose to load them', () => {
    expect(renderPath(ID, false)).toBe(`/api/messages/${ID}/render`);
    expect(renderPath(ID, true)).toBe(`/api/messages/${ID}/render?images=1`);
  });

  it('says why images are blocked, and only when some are', () => {
    expect(blockedImagesNote({ images: false, remoteImages: 0 })).toBeNull();
    expect(blockedImagesNote({ images: true, remoteImages: 3 })).toBeNull();
    expect(blockedImagesNote({ images: false, remoteImages: 1 })).toMatch(/^One image .* it is blocked\.$/);
    expect(blockedImagesNote({ images: false, remoteImages: 3 })).toMatch(/^3 images .* they are blocked\.$/);
  });
});
