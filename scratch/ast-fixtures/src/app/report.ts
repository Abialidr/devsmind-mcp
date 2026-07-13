import * as dates from '../utils/dates';

// Namespace import: `dates.formatDate(...)`. Should link to formatDate only,
// not to the other members of the dates module.
export function makeReport(s: string): string {
  return dates.formatDate(s);
}
