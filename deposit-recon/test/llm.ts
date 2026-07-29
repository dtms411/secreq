import {
  layoutPrompt, matchPrompt, sanitizeSuggestion,
  type MatchCandidate, type MatchSuggestion,
} from '../src/llm/propose.js';
import { makeChecker } from './_assert.js';

const { check, done } = makeChecker();

console.log('llm proposer — pure prompt + invariant guards');

// Prompts are pure and carry the "propose only" framing.
const lp = layoutPrompt('MERIDIAN BANK\n  Date  Description  Amount');
check('layout system prompt forbids deciding', /do NOT|not decide|conservative/i.test(lp.system));
check('layout user prompt includes the page text', lp.user.includes('MERIDIAN BANK'));

const candidates: MatchCandidate[] = [
  { leaseId: 'L1', tenantName: 'Rivera M', unit: '4B', expectedDepositCents: 240000 },
  { leaseId: 'L2', tenantName: 'Okonkwo A', unit: '2R', expectedDepositCents: 265000 },
];
const mp = matchPrompt({ descriptor: 'DEPOSIT RIVERA', amountCents: 240000, postedOn: '2025-04-03' }, candidates);
check('match system prompt says human approves', /only SUGGEST|human approves/i.test(mp.system));
check('match user prompt lists candidates', mp.user.includes('L1') && mp.user.includes('Okonkwo A'));

// The invariant guard: a hallucinated leaseId is dropped; confidence clamped.
const hallucinated: MatchSuggestion = { leaseId: 'L-NONEXISTENT', confidence: 0.9, rationale: 'x' };
check('hallucinated leaseId is rejected', sanitizeSuggestion(hallucinated, candidates).leaseId === null);

const real: MatchSuggestion = { leaseId: 'L2', confidence: 1.7, rationale: 'name+amount' };
const s = sanitizeSuggestion(real, candidates);
check('real candidate is kept', s.leaseId === 'L2');
check('confidence clamped to [0,1]', s.confidence === 1);

const nan: MatchSuggestion = { leaseId: null, confidence: Number.NaN, rationale: '' };
check('NaN confidence becomes 0', sanitizeSuggestion(nan, candidates).confidence === 0);

done('llm');
