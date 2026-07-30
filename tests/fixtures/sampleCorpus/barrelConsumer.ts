// Imports through a barrel re-export — exercises the barrel-resolution edge path.
import { barrelFn, BarrelClass } from './lib';

export function useBarrel(x: number): string {
  const inst = new BarrelClass();
  barrelFn(x);
  return inst.op();
}
