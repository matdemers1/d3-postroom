// The stage record: reading it tolerates foreign keys, a reset keeps the stages before the replay
// point, and the first incomplete stage is where a crashed job resumes.
import { describe, expect, it } from 'vitest';
import { parsePayload } from '../../src/pipeline.js';
import { firstIncomplete, readPipeline, resetFrom } from '../../src/stages/state.js';
import { STAGES } from '../../src/stages/types.js';

const at = '2026-09-25T12:00:00.000Z';
const all = Object.fromEntries(STAGES.map((s) => [s, { stage: s, at, result: { s } }]));

describe('pipeline record', () => {
  it('reads an empty or foreign verdicts value as no progress', () => {
    expect(readPipeline({ spf: {} })).toEqual({ stages: {}, replays: [] });
    expect(readPipeline(null)).toEqual({ stages: {}, replays: [] });
    expect(firstIncomplete(readPipeline({}))).toBe('verify');
  });

  it('resumes at the first stage without a marker', () => {
    const p = readPipeline({ pipeline: { stages: { verify: all['verify'], parse: all['parse'] } } });
    expect(firstIncomplete(p)).toBe('classify');
    expect(firstIncomplete(readPipeline({ pipeline: { stages: all } }))).toBeNull();
  });

  it('a reset from a stage keeps only the stages before it', () => {
    const p = readPipeline({ pipeline: { stages: all, replays: [{ jobId: 'j', fromStage: 'parse', at }] } });
    const r = resetFrom(p, 'classify');
    expect(Object.keys(r.stages)).toEqual(['verify', 'parse']);
    expect(r.replays).toEqual([{ jobId: 'j', fromStage: 'parse', at }]);
    expect(Object.keys(resetFrom(p, 'verify').stages)).toEqual([]);
    expect(Object.keys(resetFrom(p, 'notify').stages)).toEqual(['verify', 'parse', 'classify', 'sieve', 'file']);
  });
});

describe('job payload', () => {
  it('accepts the smtp-in payload and a replay, and refuses an unknown stage', () => {
    expect(parsePayload({ inboundMessageId: 'x' })).toEqual({ inboundMessageId: 'x' });
    expect(parsePayload({ inboundMessageId: 'x', replayFrom: 'file' })).toEqual({ inboundMessageId: 'x', replayFrom: 'file' });
    expect(() => parsePayload({ inboundMessageId: 'x', replayFrom: 'deliver' })).toThrow(/unknown stage/);
    expect(() => parsePayload({})).toThrow(/inboundMessageId/);
  });
});
