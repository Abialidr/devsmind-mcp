// Anonymous default export (like a Joi schema). The extractor names its node
// inconsistently (e.g. "default"), never matching the import alias the consumer chose.
export default {
  validate(input: unknown): unknown {
    return input;
  }
};
