import { OrderService } from '../services/OrderService';

// Imports OrderService but only to construct it elsewhere; `respond` itself
// only calls `res.status(...)` on an unrelated response object. Must NOT link
// to OrderService.status.
export function respond(res: { status: (code: number) => unknown }): unknown {
  return res.status(200);
}
