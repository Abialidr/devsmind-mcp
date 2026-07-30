// Exported top-level symbols — should auto-accept as candidates with isExported: true.
export function publicFn(x: number): number {
  return x + 1;
}

export class PublicClass {
  constructor(private value: number) {}

  getValue(): number {
    return this.value;
  }

  setValue(v: number): void {
    this.value = v;
  }
}

export interface PublicInterface {
  id: string;
}

export type PublicAlias = { a: number };

export enum PublicEnum {
  A,
  B
}

export const publicConst = 42;
