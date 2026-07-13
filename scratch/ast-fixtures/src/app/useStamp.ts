import { formatStamp } from '../utils/mixed';

// Imports the FREE function formatStamp. Must link to it only — NOT to the same-named
// method Stamper.formatStamp (a method is never importable by name).
export function useStamp(): string {
  return formatStamp('x');
}
