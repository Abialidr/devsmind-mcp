import thingValidator from '../schemas/thing.schema';

// Default import with an alias ("thingValidator") that does not match the schema node's
// extractor-given name. Must still link to the schema (small anonymous-default file).
export function handleThing(input: unknown): unknown {
  return thingValidator.validate(input);
}
