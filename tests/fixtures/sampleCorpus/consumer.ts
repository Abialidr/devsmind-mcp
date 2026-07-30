// Cross-file import + usage — exercises resolveConnectionsLocally's cross-file branch.
import { publicFn, PublicClass } from './exported';

export function consumeExported(x: number): number {
  const inst = new PublicClass(x);
  inst.setValue(publicFn(x));
  return inst.getValue();
}
