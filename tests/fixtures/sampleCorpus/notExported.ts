// Non-exported (ambiguous) top-level symbols — isExported: false, would go to curation.
function privateHelper(x: number): number {
  return x * 2;
}

class InternalThing {
  run(): void {
    // no-op
  }
}

const localConst = 'local';

export function usesPrivateHelper(x: number): number {
  // Same-file reference to a non-exported symbol — exercises the same-file edge path.
  return privateHelper(x);
}
