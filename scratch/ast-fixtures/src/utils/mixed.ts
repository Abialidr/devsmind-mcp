// Same file holds a free function AND a class with a same-named method.
export function formatStamp(d: string): string {
  return d;
}

export class Stamper {
  formatStamp(x: number): number {
    return x;
  }
}
