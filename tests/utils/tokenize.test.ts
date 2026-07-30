import { splitIdentifier, stem, tokenizeText, tokenizeIdentifier, validateDescription } from '../../src/utils/tokenize';

describe('splitIdentifier', () => {
  it('returns [] for empty/falsy input', () => {
    expect(splitIdentifier('')).toEqual([]);
  });

  it('splits camelCase', () => {
    expect(splitIdentifier('verifyCredentials')).toEqual(['verify', 'credentials']);
  });

  it('splits PascalCase', () => {
    expect(splitIdentifier('VerifyCredentials')).toEqual(['verify', 'credentials']);
  });

  it('splits snake_case', () => {
    expect(splitIdentifier('verify_credentials')).toEqual(['verify', 'credentials']);
  });

  it('splits kebab-case', () => {
    expect(splitIdentifier('verify-credentials')).toEqual(['verify', 'credentials']);
  });

  it('splits dotted paths', () => {
    expect(splitIdentifier('pages/product-detail')).toEqual(['pages', 'product', 'detail']);
  });

  it('splits acronym boundaries like XMLParser', () => {
    expect(splitIdentifier('XMLParser')).toEqual(['xml', 'parser']);
  });

  it('splits a mix of acronym + camel + separators', () => {
    expect(splitIdentifier('parseHTTPResponseBody')).toEqual(['parse', 'http', 'response', 'body']);
  });

  it('handles digits as boundaries via camelCase rule', () => {
    expect(splitIdentifier('login2Factor')).toEqual(['login2', 'factor']);
  });

  it('drops non-alphanumeric separators entirely', () => {
    expect(splitIdentifier('a__b--c..d')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('lowercases all output', () => {
    expect(splitIdentifier('ABC')).toEqual(['abc']);
  });
});

describe('stem', () => {
  it('leaves tokens of length <= 4 untouched', () => {
    expect(stem('abcd')).toBe('abcd');
    expect(stem('a')).toBe('a');
  });

  it('strips "ies" -> "y" when long enough', () => {
    expect(stem('parties')).toBe('party');
  });

  it('does not strip "ies" when result would be too short (length <= 5)', () => {
    // "ties" length 4 already caught by length guard; test a 5-length "ies" word boundary
    expect(stem('pies')).toBe('pies'); // length 4, caught by <=4 guard
  });

  it('strips "ing" when length > 6', () => {
    expect(stem('running')).toBe('runn'); // 'running' -> length 7 > 6, strip -> 'runn'
  });

  it('does not strip "ing" when length <= 6', () => {
    expect(stem('sing')).toBe('sing'); // length 4, <=4 guard anyway
    expect(stem('doing')).toBe('doing'); // length 5, > 4, not > 6, so 'ing' rule skipped; falls through
  });

  it('strips "tion" when length > 6', () => {
    expect(stem('validation')).toBe('valida');
  });

  it('does not strip "tion" when length <= 6', () => {
    expect(stem('nation')).toBe('nation'); // length 6, not > 6
  });

  it('strips "ed" when length > 5', () => {
    expect(stem('logged')).toBe('logg');
  });

  it('does not strip "ed" when length <= 5', () => {
    expect(stem('used')).toBe('used'); // length 4, <=4 guard
    expect(stem('hated')).toBe('hated'); // length 5, not > 5
  });

  it('strips "es" when length > 5', () => {
    expect(stem('indexes')).toBe('index'); // length 7 > 5 -> strip 'es'
    // A 5-letter word ending in "es" fails the es-rule's length>5 check and instead falls
    // through to the generic trailing-"s" rule (length>4), stripping only the final "s".
    expect(stem('boxes')).toBe('boxe');
  });

  it('strips trailing "s" (not "ss") when length > 4', () => {
    expect(stem('logins')).toBe('login');
  });

  it('does not strip trailing "s" when it ends with "ss"', () => {
    expect(stem('access')).toBe('access');
  });

  it('does not strip trailing "s" when length <= 4', () => {
    expect(stem('bus')).toBe('bus'); // length 3, <=4 guard
  });

  it('returns token unchanged when no suffix rule matches', () => {
    expect(stem('purple')).toBe('purple');
  });
});

describe('tokenizeText', () => {
  it('returns [] for empty input', () => {
    expect(tokenizeText('')).toEqual([]);
  });

  it('lowercases and splits on non-alphanumeric', () => {
    expect(tokenizeText('Verify User Credentials')).toEqual(['verify', 'user', 'credentials'].map(stem));
  });

  it('drops tokens shorter than 3 chars', () => {
    const out = tokenizeText('a an id ok go');
    // 'id' (2) dropped, 'ok' (2) dropped, 'go' (2) dropped, 'an' is also a stopword+short
    expect(out).not.toContain('id');
    expect(out).not.toContain('ok');
    expect(out).not.toContain('go');
  });

  it('drops stopwords', () => {
    const out = tokenizeText('where do we handle user login');
    expect(out).not.toContain('where');
    expect(out).not.toContain('handle');
    expect(out).not.toContain('we');
    expect(out).toContain(stem('user'));
    expect(out).toContain(stem('login'));
  });

  it('stems remaining tokens', () => {
    const out = tokenizeText('validated logins');
    expect(out).toEqual([stem('validated'), stem('logins')]);
  });
});

describe('tokenizeIdentifier', () => {
  it('splits then applies the text pipeline', () => {
    expect(tokenizeIdentifier('verifyUserCredentials')).toEqual(
      tokenizeText('verify user credentials')
    );
  });

  it('handles empty input', () => {
    expect(tokenizeIdentifier('')).toEqual([]);
  });

  it('drops short/stopword fragments from identifiers too', () => {
    // 'to' is a stopword and short
    const out = tokenizeIdentifier('mapToDto');
    expect(out).not.toContain('to');
  });
});

describe('validateDescription', () => {
  it('rejects descriptions shorter than MIN_DESCRIPTION_LENGTH (40)', () => {
    const result = validateDescription('too short', 'verifyCredentials');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/too short/i);
  });

  it('rejects a precisely constructed pure restatement', () => {
    const identifier = 'verifyCredentials';
    // identifier tokens (after tokenizeIdentifier): stem('verify'), stem('credentials')
    // Build a description using ONLY those words, long enough to pass length gate.
    const description = 'Verify credentials. Verify credentials. Verify the credentials of the credentials.';
    const result = validateDescription(description, identifier);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/only restates/i);
  });

  it('accepts a good description that adds real vocabulary', () => {
    const identifier = 'verifyCredentials';
    const description = 'Checks the supplied username and password against the stored bcrypt hash in the users table.';
    const result = validateDescription(description, identifier);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('accepts a description when identifierSource has no tokens (identifierTokens.size === 0)', () => {
    const description = 'Checks the supplied username and password against the stored bcrypt hash in the users table.';
    const result = validateDescription(description, '123'); // splits to nothing useful/no letters
    expect(result.ok).toBe(true);
  });

  it('trims whitespace before checking length', () => {
    const result = validateDescription('   short   ', 'anything');
    expect(result.ok).toBe(false);
  });

  it('handles null/undefined-ish description gracefully via the || fallback', () => {
    // @ts-expect-error - intentionally testing the `description || ''` fallback branch
    const result = validateDescription(undefined, 'verifyCredentials');
    expect(result.ok).toBe(false);
  });
});
