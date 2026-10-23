'use strict';
/**
 * Minimal web service for the ECS Fargate tier.
 *
 *   GET /health    liveness: process is up. The ALB and the container health check use THIS.
 *   GET /db-check  readiness-style: proves the task can reach Postgres over verified TLS.
 *   GET /          small JSON banner.
 *
 * Why /health does not touch the database: if the DB has a 30-second blip and /health depended on it,
 * the ALB would mark EVERY task unhealthy, ECS would kill them all, and a partial dependency problem
 * becomes a full outage with a cold restart. Liveness checks the process; dependencies are
 * checked separately (/db-check, alarms).
 *
 * Plain JS with one dependency (pg) keeps the image small and the Trivy report short.
 */
const http = require('node:http');
const fs = require('node:fs');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 8080);
const RDS_CA_PATH = '/app/rds-ca.pem';

let pool;
function getPool() {
  if (!pool) {
    const ca = fs.existsSync(RDS_CA_PATH) ? fs.readFileSync(RDS_CA_PATH, 'utf8') : undefined;
    pool = new Pool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      // Verify the server certificate against the RDS CA bundle (rejectUnauthorized stays true).
      ssl: ca ? { ca, rejectUnauthorized: true } : true,
      max: 5, // tasks x pool size must stay below the DB's max_connections
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 30000,
    });
    pool.on('error', (err) => console.error(JSON.stringify({ level: 'error', message: 'pool error', error: err.message })));
  }
  return pool;
}

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/health') return send(res, 200, { status: 'ok' });
    if (req.url === '/db-check') {
      const { rows } = await getPool().query('select now() as db_time');
      return send(res, 200, { status: 'ok', dbTime: rows[0].db_time });
    }
    if (req.url === '/') return send(res, 200, { service: 'orders-web', version: process.env.APP_VERSION || 'dev' });
    return send(res, 404, { message: 'not found' });
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', message: 'request failed', url: req.url, error: err.message }));
    return send(res, 503, { status: 'unavailable' });
  }
});

server.listen(PORT, () => console.log(JSON.stringify({ level: 'info', message: `listening on ${PORT}` })));

// ECS sends SIGTERM, waits `stopTimeout` (30s in the task definition), then SIGKILL.
// Stop accepting new connections, let in-flight requests finish, then exit cleanly: no dropped requests on deploy.
function shutdown(signal) {
  console.log(JSON.stringify({ level: 'info', message: `received ${signal}, draining` }));
  server.close(async () => {
    if (pool) await pool.end().catch(() => undefined);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 25000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
