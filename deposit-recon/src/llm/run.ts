import { db } from '../db.js';
import { proposeMatch, hasKey, type MatchCandidate } from './propose.js';

// Runs the LLM matcher over bank transactions the tiered rules left unmatched.
// Every suggestion lands in `matches` as method='llm_suggested', decided_by=null
// — a proposal a human must approve. This never resolves an exception, never
// writes a ledger entry, and never sets decided_by.

export interface LlmRunResult { considered: number; suggested: number; abstained: number; }

export async function runLlmMatching(minConfidence = 0.5): Promise<LlmRunResult> {
  if (!hasKey()) throw new Error('ANTHROPIC_API_KEY is not set — cannot run the LLM matcher');

  // Only transactions with no match at all, scoped to their building's leases.
  const { data: txns, error } = await db
    .from('bank_transactions')
    .select('id, amount_cents, posted_on, descriptor, check_no, bank_accounts(building_id)')
    .order('posted_on');
  if (error) throw error;

  const { data: matched } = await db.from('matches').select('bank_transaction_id');
  const already = new Set((matched ?? []).map((m: any) => m.bank_transaction_id));

  const leasesByBuilding = new Map<string, MatchCandidate[]>();
  async function candidatesFor(buildingId: string): Promise<MatchCandidate[]> {
    if (leasesByBuilding.has(buildingId)) return leasesByBuilding.get(buildingId)!;
    const { data } = await db
      .from('leases').select('id, tenant_name, unit, expected_deposit_cents').eq('building_id', buildingId);
    const rows: MatchCandidate[] = (data ?? []).map((l: any) => ({
      leaseId: l.id, tenantName: l.tenant_name, unit: l.unit, expectedDepositCents: Number(l.expected_deposit_cents),
    }));
    leasesByBuilding.set(buildingId, rows);
    return rows;
  }

  const result: LlmRunResult = { considered: 0, suggested: 0, abstained: 0 };

  for (const t of (txns ?? []) as any[]) {
    if (already.has(t.id)) continue;
    const buildingId = t.bank_accounts?.building_id;
    if (!buildingId) continue;
    const candidates = await candidatesFor(buildingId);
    if (!candidates.length) continue;
    result.considered++;

    const s = await proposeMatch(
      { descriptor: t.descriptor, amountCents: Number(t.amount_cents), postedOn: t.posted_on, checkNo: t.check_no },
      candidates,
    );

    if (!s.leaseId || s.confidence < minConfidence) { result.abstained++; continue; }

    await db.from('matches').insert({
      bank_transaction_id: t.id,
      lease_id: s.leaseId,
      method: 'llm_suggested',
      confidence: s.confidence,
      decided_by: null,           // a human decides; the model only proposed
    });
    result.suggested++;
  }

  console.log(
    `llm matching: ${result.considered} considered — ${result.suggested} suggested, ` +
    `${result.abstained} abstained (all pending human approval)`,
  );
  return result;
}
