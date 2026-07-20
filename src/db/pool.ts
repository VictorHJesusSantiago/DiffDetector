import { Pool } from "pg";
import "dotenv/config";

const connectionString = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/drift_detector";

export const pool = new Pool({ connectionString });

export async function closePool(): Promise<void> {
  await pool.end();
}
