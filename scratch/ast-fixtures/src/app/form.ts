// Uses `validateEmailAddress` ONLY as an object-literal key (a definition), never
// as a real call, and does not import the validators file. Must NOT link to
// validateEmailAddress.
export function buildForm() {
  const opts = { validateEmailAddress: false };
  return opts;
}
