// Render-time redaction for session-capture transcripts (ticket #35).
// Raw bodies stay raw in R2; the dashboard rewrites local filesystem
// paths and credential-bearing URLs into stable tokens and reports a
// ledger of what it replaced, so a transcript can be read or shared
// internally without leaking machine details. Nothing mutates captures
// in flight — this pass runs on the payload at render, never in storage.

export type RedactionKind = "path" | "credential-url";

export interface RedactionEntry {
  token: string;
  kind: RedactionKind;
  count: number;
}

// The shape redaction reads: a transcript message as the schema defines
// it, with readonly-tolerant fields.
interface LlmMessageLike {
  readonly role: string;
  readonly content: unknown;
}

export interface RedactionLedger {
  messages: Array<{ role: string; content: unknown }>;
  ledger: RedactionEntry[];
}

// Local absolute paths on the machines workbench runs on, and URLs that
// embed credentials in their userinfo (https://token@host or
// https://user:pass@host). Both patterns are conservative: only strings
// that unmistakably point at a filesystem location or carry credentials
// are rewritten.
const PATH_PATTERN = /\/(?:Users|home|data|tmp|var|opt|etc|srv|mnt)(?:\/[\w.()-]+)+/g;
const CREDENTIAL_URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@[^\s<>"']+/g;

class Redactor {
  private tokens = new Map<string, string>();
  readonly ledger: RedactionEntry[] = [];

  redact(text: string): string {
    const withUrls = text.replace(CREDENTIAL_URL_PATTERN, (original) =>
      this.token(original, "credential-url"),
    );
    return withUrls.replace(PATH_PATTERN, (original) => this.token(original, "path"));
  }

  private token(original: string, kind: RedactionKind): string {
    const existing = this.tokens.get(original);
    if (existing) {
      const entry = this.ledger.find((candidate) => candidate.token === existing);
      if (entry) entry.count += 1;
      return existing;
    }
    const ordinal = this.ledger.filter((entry) => entry.kind === kind).length + 1;
    const token = `[REDACTED-${kind.toUpperCase()}-${ordinal}]`;
    this.tokens.set(original, token);
    this.ledger.push({ token, kind, count: 1 });
    return token;
  }
}

// Redacts a transcript's messages into stable tokens. Message content may
// be a plain string or provider content blocks; only text passes through
// the redactor, everything else is left untouched.
export function redactTranscript(messages: ReadonlyArray<LlmMessageLike>): RedactionLedger {
  const redactor = new Redactor();
  const redacted = messages.map((message) => ({
    role: message.role,
    content: redactContent(redactor, message.content),
  }));
  return { messages: redacted, ledger: redactor.ledger };
}

function redactContent(redactor: Redactor, content: unknown): unknown {
  if (typeof content === "string") return redactor.redact(content);
  if (Array.isArray(content)) return content.map((block) => redactBlock(redactor, block));
  return content;
}

function redactBlock(redactor: Redactor, block: unknown): unknown {
  if (
    block &&
    typeof block === "object" &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  ) {
    return {
      ...(block as { text: string }),
      text: redactor.redact((block as { text: string }).text),
    };
  }
  return block;
}
