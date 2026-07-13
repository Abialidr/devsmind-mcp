import { formatDate } from '../utils/dates';

export function Cart() {
  function handleRemove(when: string) {
    return formatDate(when);
  }
  return handleRemove;
}
