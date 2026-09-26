// iCalendar (RFC 5545) parser, serializer and recurrence expansion — hand-rolled, no dependencies.
// PST-T-8.1 for PST-REQ-132 (CalDAV) and PST-REQ-088 (property tests + fuzz target).
export const PACKAGE = '@postroom/ical';

export { ICalError, ICalLimitError, ICalParseError } from './errors.js';
export {
  decodeParamValue,
  encodeParamValue,
  escapeText,
  fold,
  FOLD_OCTETS,
  formatContentLine,
  parseContentLine,
  splitUnescaped,
  unescapeText,
  unfold,
  utf8Length,
} from './lexer.js';
export type { ContentLine, LogicalLine, Params } from './lexer.js';
export {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_LINES,
  getComponents,
  getParam,
  getProperties,
  getProperty,
  parseICalendar,
  parseICalendarAll,
  serializeICalendar,
} from './component.js';
export type { Component, ParseOptions, Property } from './component.js';
export {
  calAddressEmail,
  durationParts,
  durationToSeconds,
  formatDate,
  formatDateTime,
  formatDateValue,
  formatDuration,
  formatPeriod,
  formatText,
  formatTextList,
  formatUtcOffset,
  parseDate,
  parseDateOrDateTime,
  parseDateTime,
  parseDuration,
  parsePeriod,
  parseText,
  parseTextList,
  parseUtcOffset,
  propertyDate,
  propertyDateList,
} from './values.js';
export type { ICalDate, ICalDateTime, ICalDateValue, ICalDuration, ICalPeriod } from './values.js';
export { createBudget, formatRecur, iterateRecur, parseRecur, WEEKDAYS } from './recur.js';
export type { Budget, Frequency, IterateOptions, Recur, StopReason, WeekdayNum } from './recur.js';
export { createTimeZoneResolver, dateTimeToUtc, intlOffsetAt, localToUtc, VTimezone } from './timezone.js';
export type { TimeZoneResolver, TimeZoneResolverOptions } from './timezone.js';
export { DEFAULT_MAX_INSTANCES, DEFAULT_MAX_ITERATIONS, expandCalendar, expandComponent, occurrences } from './expand.js';
export type { ExpandOptions, ExpandResult, Instance, OccurrencesOptions, OccurrencesResult } from './expand.js';
