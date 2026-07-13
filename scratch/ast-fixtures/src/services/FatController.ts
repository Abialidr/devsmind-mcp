// Internal (non-exported) top-level symbols + a default export. A default import of
// this file must link ONLY to the default export (FatController), never to these.
const INTERNAL_RANK = { a: 1 };

function internalHelper(x: number): number {
  return x + INTERNAL_RANK.a;
}

class FatController {
  listThings(): number {
    return internalHelper(1);
  }
  removeThing(): number {
    return 2;
  }
}

export default FatController;
