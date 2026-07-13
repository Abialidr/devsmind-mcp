import addSchema from '../schema';

export function addToCart(input: unknown): unknown {
  return addSchema.parse(input);
}
