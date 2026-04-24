const { Pool } = require("pg");

const requiredEnv = ["DATABASE_URL"];

const isProduction = process.env.NODE_ENV === "production";
if (isProduction) {
  const missing = requiredEnv.filter((name) => !process.env[name]);
  if (!process.env.JWT_SECRET) missing.push("JWT_SECRET");
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false }
});

const query = (text, params) => pool.query(text, params);

module.exports = {
  pool,
  query
};
