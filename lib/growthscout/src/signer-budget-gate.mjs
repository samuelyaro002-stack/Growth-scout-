import pg from 'pg';
import { randomUUID } from 'node:crypto';

// Child independently consumes a one-use shared reservation BEFORE signer activation.
export async function claimSignerReservation(wallet, endpoint, maxUsd) {
  const url = process.env.BUDGET_DATABASE_URL;
  const authority = process.env.BUDGET_AUTHORITY_ID;
  const id = process.env.BUDGET_RESERVATION_ID;
  delete process.env.BUDGET_DATABASE_URL;
  delete process.env.BUDGET_AUTHORITY_ID;
  delete process.env.BUDGET_RESERVATION_ID;
  if (!url || !authority || !id) throw new Error('Shared signer reservation required.');
  const pool = new pg.Pool({ connectionString: url, max: 1,
    connectionTimeoutMillis: 5000, statement_timeout: 10000,
    idle_in_transaction_session_timeout: 15000 });
  let c;
  try {
    c = await pool.connect();
    await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await c.query('SET LOCAL synchronous_commit = on');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [wallet]);
    const policy = await c.query(`SELECT 1 FROM public.growth_wallets
      WHERE wallet=$1 AND authority=$2 AND enabled AND reconciled`, [wallet, authority]);
    if (policy.rowCount !== 1) throw new Error('Shared signer policy unavailable.');
    const reservation = await c.query(`SELECT entry FROM public.growth_evidence
      WHERE wallet=$1 AND kind='reserved' AND reservation_id=$2`, [wallet, id]);
    const entry = reservation.rows[0]?.entry;
    const ended = await c.query(`SELECT 1 FROM public.growth_evidence
      WHERE wallet=$1 AND reservation_id=$2 AND kind IN ('spend','launched')`, [wallet, id]);
    if (!entry || ended.rowCount || entry.capUsd !== maxUsd) throw new Error('Reservation is missing or already used.');
    await c.query(`INSERT INTO public.growth_evidence(id,wallet,kind,reservation_id,dedupe,entry,ts)
      VALUES($1,$2,'launched',$3,$4,$5,clock_timestamp())`,
      [randomUUID(), wallet, id, `launch:${id}`,
        JSON.stringify({ kind: 'launched', endpoint, usd: 0, ok: false, reservationId: id })]);
    await c.query('COMMIT');
  } catch {
    await c?.query('ROLLBACK').catch(() => {});
    throw new Error('Shared signer reservation not confirmed; nothing signed.');
  } finally { c?.release(); await pool.end(); }
}
