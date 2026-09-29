// The sorting-correction routes in the OpenAPI document (PST-T-14.9, PST-REQ-085), generated from the
// same zod objects the routes validate with (schemas.ts). Spread into ROUTES/COMPONENTS by
// src/openapi/document.ts.
import type { z } from 'zod';
import type { ResponseSpec, RouteSpec } from '../openapi/document.js';
import * as V from './schemas.js';

export const SORTING_COMPONENTS: Record<string, z.ZodType> = {
  SortingCorrection: V.SortingCorrection,
  SortingCorrectionResult: V.CorrectionResult,
  SortingCorrectionList: V.CorrectionList,
  SortingCorrectionUndo: V.UndoResult,
};

const err = (description: string): ResponseSpec => ({ description, schema: 'Error' });
const CSRF = [{ name: 'x-postroom-csrf', required: true, description: 'Must be 1.' }];

export const SORTING_ROUTES: RouteSpec[] = [
  {
    method: 'get',
    path: '/api/sorting/corrections',
    operationId: 'listSortingCorrections',
    tag: 'Sorting',
    summary: 'The caller’s sorting corrections that are still in force, newest first (Settings → Rules → Sorting corrections).',
    responses: { '200': { description: 'Corrections.', schema: 'SortingCorrectionList' }, '401': err('No session.') },
  },
  {
    method: 'post',
    path: '/api/sorting/corrections',
    operationId: 'createSortingCorrection',
    tag: 'Sorting',
    summary: 'Correct where a message was sorted: move it to a bucket and record a sender preference the sorter honours for new mail (PST-ADR-011).',
    description:
      'In one transaction: a sender pin on the From address (or on "@domain" when scope is domain), a move to the bucket’s mailbox (INBOX with $Priority/$People, a bucket folder, or Junk) that trains the Bayes model like any move, the stored verdict updated with one more reason, and a correction row that Undo reverses. Audited. Needs x-postroom-csrf: 1.',
    body: V.CorrectionBody,
    headers: CSRF,
    responses: {
      '201': { description: 'Corrected.', schema: 'SortingCorrectionResult' },
      '400': err('The request failed validation, the message has no sender, or a domain preference was asked for where it is not allowed.'),
      '401': err('No session.'),
      '403': err('Missing CSRF header.'),
      '404': err('No such message.'),
      '409': err('The account has no mailbox for that bucket.'),
    },
  },
  {
    method: 'post',
    path: '/api/sorting/corrections/{id}/undo',
    operationId: 'undoSortingCorrection',
    tag: 'Sorting',
    summary: 'Undo a sorting correction: the sender preference goes back as it was and the message goes back where it came from, when each is still as the correction left it.',
    description: 'The correction row is kept and marked undone, never deleted. Audited. Needs x-postroom-csrf: 1.',
    params: V.CorrectionIdParams,
    headers: CSRF,
    responses: {
      '200': { description: 'Undone.', schema: 'SortingCorrectionUndo' },
      '400': err('The request failed validation.'),
      '401': err('No session.'),
      '403': err('Missing CSRF header.'),
      '404': err('No such correction.'),
      '409': err('Already undone.'),
    },
  },
];
