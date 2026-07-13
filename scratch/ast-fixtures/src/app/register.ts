// Calls validateEmailAddress as a real function but (deliberately) without an
// import statement — simulates a globally-available / ambient helper. The
// same-repo long-unique-name fallback should still catch this true positive.
export function registerUser(email: string): boolean {
  return validateEmailAddress(email);
}
declare function validateEmailAddress(email: string): boolean;
