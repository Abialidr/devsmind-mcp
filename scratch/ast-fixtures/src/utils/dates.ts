export function convertStringToDate(s: string): Date {
  return new Date(s);
}

export function formatDate(s: string): string {
  const d = convertStringToDate(s);
  return d.toISOString();
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
