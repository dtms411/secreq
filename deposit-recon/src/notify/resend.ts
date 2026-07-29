// Minimal Resend client. Delivery of the 14-day escalations goes through
// Resend; this wraps the one endpoint we need with no dependency. When
// RESEND_API_KEY is absent the sender runs in dry-run mode and returns a
// synthetic id, so the clock is fully exercisable locally without sending mail.

export interface SendArgs {
  to: string[];
  subject: string;
  text: string;
}

export interface SendResult {
  id: string;
  delivered: boolean;   // false in dry-run
}

export async function sendEmail(args: SendArgs): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.DEADLINE_ALERT_FROM ?? 'deposit-recon@localhost';

  if (!key) {
    console.log(`  [dry-run] would email ${args.to.join(', ')}: ${args.subject}`);
    return { id: 'dry-run', delivered: false };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: args.to, subject: args.subject, text: args.text }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { id: string };
  return { id: json.id, delivered: true };
}
