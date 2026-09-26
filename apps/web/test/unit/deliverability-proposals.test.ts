// PST-T-7.2 (PST-REQ-123): the DMARC progression proposal's summary sentence and evidence-row
// formatting, pulled out of AdminDeliverability so they are unit-testable without rendering.
import { describe, expect, it } from 'vitest';
import { evidenceRowText, proposalSummary, type ProposalEvidenceDay } from '../../src/api';

describe('proposalSummary', () => {
  it('names the current and proposed stage and pct', () => {
    expect(proposalSummary({ currentStage: 'none', currentPct: 100, proposedStage: 'quarantine', proposedPct: 100 })).toBe(
      '14 consecutive clean UTC days: propose moving from p=none; pct=100 to p=quarantine; pct=100.',
    );
  });

  it('describes a pct-only ramp within the same stage', () => {
    expect(proposalSummary({ currentStage: 'quarantine', currentPct: 50, proposedStage: 'quarantine', proposedPct: 75 })).toBe(
      '14 consecutive clean UTC days: propose moving from p=quarantine; pct=50 to p=quarantine; pct=75.',
    );
  });
});

describe('evidenceRowText', () => {
  it('joins sources and reporting orgs for one evidence day', () => {
    const day: ProposalEvidenceDay = { day: '2026-09-01', reports: 2, messages: 30, sources: ['203.0.113.1', '203.0.113.2'], orgs: ['google.com', 'Enterprise Outlook'] };
    expect(evidenceRowText(day)).toEqual({ sources: '203.0.113.1, 203.0.113.2', orgs: 'google.com, Enterprise Outlook' });
  });

  it('renders an empty string for a day with no sources or orgs recorded', () => {
    const day: ProposalEvidenceDay = { day: '2026-09-02', reports: 0, messages: 0, sources: [], orgs: [] };
    expect(evidenceRowText(day)).toEqual({ sources: '', orgs: '' });
  });
});
