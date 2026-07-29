import Anthropic from '@anthropic-ai/sdk';

// The LLM may PROPOSE, never POST (invariant 6). This module produces two kinds
// of suggestion and nothing else:
//
//   1. A layout proposal — a first guess at an unfamiliar statement's column
//      structure, to hand a human writing a new parser. It is advisory only and
//      is NEVER auto-registered as a parser: a model-inferred layout that posts
//      numbers unsupervised is exactly the failure this system exists to catch.
//
//   2. A match proposal — which lease of the building a bank transaction likely
//      belongs to, with a confidence score. The runner writes it to `matches`
//      with method='llm_suggested' and decided_by=null. It counts for nothing
//      until a human sets decided_by.
//
// Extraction method is recorded as model-read, never conflated with the machine
// -read pdftotext/csv paths. Every figure a model touches stays distinguishable
// in a report.

const MODEL = 'claude-opus-5';

function client(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set — the LLM proposer cannot run offline');
  return new Anthropic({ apiKey: key });
}

export function hasKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/** Force a JSON-schema-shaped response and parse it. output_config.format is the
 *  current structured-output surface; typed loosely so a lagging SDK version
 *  still compiles. */
async function callStructured<T>(system: string, user: string, schema: object): Promise<T> {
  const res = await client().messages.create({
    model: MODEL,
    max_tokens: 2048,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { format: { type: 'json_schema', schema } },
  } as Anthropic.MessageCreateParamsNonStreaming);
  const text = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
  return JSON.parse(text) as T;
}

// ------------------------------------------------------------ layout proposal

export interface LayoutProposal {
  columns: { key: string; headerHint: string }[];
  dateFormat: string;
  debitStyle: 'separate_columns' | 'trailing_minus' | 'parenthesised';
  confidence: number;
  rationale: string;
}

const LAYOUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    columns: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { key: { type: 'string' }, headerHint: { type: 'string' } },
        required: ['key', 'headerHint'],
      },
    },
    dateFormat: { type: 'string' },
    debitStyle: { type: 'string', enum: ['separate_columns', 'trailing_minus', 'parenthesised'] },
    confidence: { type: 'number' },
    rationale: { type: 'string' },
  },
  required: ['columns', 'dateFormat', 'debitStyle', 'confidence', 'rationale'],
};

export function layoutPrompt(pageText: string): { system: string; user: string } {
  return {
    system:
      'You reverse-engineer bank statement layouts to help a human write a parser. ' +
      'You do NOT extract figures and you do NOT decide anything — you describe the ' +
      'column structure so a person can write and test a parser against it. Be conservative: ' +
      'if the layout is ambiguous, say so with low confidence.',
    user:
      'Here is the first page of a bank statement whose format we do not yet recognise. ' +
      'Propose the transaction-table column layout: for each column give a canonical key ' +
      '(date, desc, check, debit, credit, balance, amount) and the header text that marks it; ' +
      'the date format; and how debits are signalled. Confidence 0..1.\n\n---\n' + pageText,
  };
}

export async function proposeLayout(pageText: string): Promise<LayoutProposal> {
  const { system, user } = layoutPrompt(pageText);
  return callStructured<LayoutProposal>(system, user, LAYOUT_SCHEMA);
}

// ------------------------------------------------------------- match proposal

export interface MatchCandidate { leaseId: string; tenantName: string; unit: string; expectedDepositCents: number; }
export interface MatchSuggestion { leaseId: string | null; confidence: number; rationale: string; }

const MATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    leaseId: { type: ['string', 'null'] },
    confidence: { type: 'number' },
    rationale: { type: 'string' },
  },
  required: ['leaseId', 'confidence', 'rationale'],
};

export function matchPrompt(
  txn: { descriptor: string; amountCents: number; postedOn: string; checkNo?: string | null },
  candidates: MatchCandidate[],
): { system: string; user: string } {
  return {
    system:
      'You suggest which tenant lease a bank transaction most likely belongs to. ' +
      'You only SUGGEST — a human approves every match. Return the single best candidate ' +
      'leaseId or null if none is plausible, with a confidence 0..1 and a one-line rationale. ' +
      'Do not invent a leaseId that is not in the candidate list.',
    user: JSON.stringify({ transaction: txn, candidates }, null, 2),
  };
}

/** Guard the invariant at the boundary: a suggested leaseId must be a real
 *  candidate of this building, and confidence is clamped to [0,1]. The model
 *  proposes; we never trust it to stay in bounds. Pure, so it is testable. */
export function sanitizeSuggestion(s: MatchSuggestion, candidates: MatchCandidate[]): MatchSuggestion {
  const leaseId = s.leaseId && candidates.some(c => c.leaseId === s.leaseId) ? s.leaseId : null;
  return { leaseId, confidence: Math.max(0, Math.min(1, Number(s.confidence) || 0)), rationale: s.rationale ?? '' };
}

export async function proposeMatch(
  txn: { descriptor: string; amountCents: number; postedOn: string; checkNo?: string | null },
  candidates: MatchCandidate[],
): Promise<MatchSuggestion> {
  const { system, user } = matchPrompt(txn, candidates);
  const s = await callStructured<MatchSuggestion>(system, user, MATCH_SCHEMA);
  return sanitizeSuggestion(s, candidates);
}
