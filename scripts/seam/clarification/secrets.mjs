// Secret-bearing content detection (spec #221, ticket #238, ADR 0016): the
// coordinator's defense-in-depth scan over everything that could carry a
// credential out of this machine — runtime output frames, the Developer's
// conversation inputs, the Clarification draft, and the publication body.
// ADR 0016 is explicit that exclusion and redaction are defense in depth,
// not proof: a clean scan claims nothing, a hit stops the path it is on.
//
// The patterns are the well-known shapes of the credentials this
// capability's cohort can plausibly hold (tracker tokens, provider keys,
// cloud keys, private keys, bearer headers, JWTs). Each hit names a kind —
// never the matched bytes — so the evidence that a secret appeared can be
// recorded without recording the secret.

const PATTERNS = [
  // The whole block — header to footer, or to the end of the text when the
  // footer never arrived — so redaction removes the key material too.
  {
    kind: "private-key",
    pattern:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g,
  },
  {
    kind: "github-token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g,
  },
  { kind: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "openai-key", pattern: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  {
    kind: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  { kind: "bearer-credential", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
];

// Every string inside a JSON-shaped value, keys included — a secret riding
// a property name is still a secret.
const stringsOf = (value, out = []) => {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, out);
  else if (value !== null && typeof value === "object")
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      stringsOf(child, out);
    }
  return out;
};

// The kinds of secret the value carries, sorted and deduplicated; empty
// when the scan found none (which proves nothing — see the header).
export const secretKindsIn = (value) => {
  const kinds = new Set();
  for (const text of stringsOf(value))
    for (const { kind, pattern } of PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) kinds.add(kind);
    }
  return [...kinds].sort();
};

// A structural copy with every matched span replaced by its kind marker:
// the shape of the evidence survives, the secret's bytes do not.
export const redactSecrets = (value) => {
  if (typeof value === "string") {
    let text = value;
    for (const { kind, pattern } of PATTERNS) text = text.replace(pattern, `[redacted:${kind}]`);
    return text;
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [redactSecrets(key), redactSecrets(child)]),
    );
  return value;
};
