require('dotenv').config();
const dns = require('dns');
// Render's network doesn't support outbound IPv6, but Node 18+ resolves
// hostnames with both A/AAAA records (like smtp.gmail.com) IPv6-first by
// default — that mismatch is what caused ENETUNREACH connecting to Gmail.
// Forcing IPv4-first here fixes it without touching the nodemailer config.
dns.setDefaultResultOrder('ipv4first');
const express = require('express');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const { Resend } = require('resend');
const { exec } = require('child_process');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cookieParser()); // needed so req.cookies works â€” required by authenticateToken below
const cors = require('cors');
app.use(cors({
  origin: ['http://localhost:5173',
  'https://pandadsgn.github.io',],
  credentials: true
}));

// ============================================================================
// System Setup: Temp Directory, Database, and Email
// ============================================================================

// Ensure a temp directory exists for code execution
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir);
}

// Initialize PostgreSQL Connection Pool
// ssl is required for Neon (and most hosted Postgres) even when sslmode=require
// is already in the connection string — this is a belt-and-braces fallback so
// pg doesn't reject Neon's cert chain.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Email sending via Resend's HTTPS API instead of raw SMTP — Render blocks
// outbound traffic on SMTP ports 25/465/587 for free web services (since
// Sep 2025), which is what made nodemailer/Gmail time out. Resend just makes
// a normal HTTPS request, so it isn't affected by that restriction.
const resend = new Resend(process.env.RESEND_API_KEY);
// Until you verify your own domain in the Resend dashboard, you can only
// send FROM this address, and only TO the email you signed up to Resend
// with — see the note further down where this is used.
const EMAIL_FROM = process.env.EMAIL_FROM || 'CodeJudge <onboarding@resend.dev>';

/**
 * Utility: Generates a cryptographically secure 10-character alphanumeric password
 */
function generateRandomPassword(length = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += chars.charAt(crypto.randomInt(0, chars.length));
  }
  return password;
}

// ============================================================================
// Auth Middleware
// ============================================================================

/**
 * Verifies the JWT cookie set at login and attaches { userId, role } to req.user.
 * Every route that touches the Docker sandbox or student data should sit behind this â€”
 * previously nothing did, which meant /api/execute/* was callable by anyone, logged in or not.
 */
function authenticateToken(req, res, next) {
  const token = req.cookies?.token;
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ============================================================================
// Sandbox Runner â€” shared by Playground execution AND graded problem submissions
// ============================================================================

const LANGUAGE_CONFIG = {
  python: {
    filename: 'main.py',
    buildCmd: null,
    runCmd: ['python3', ['main.py']],
    memKb: 65536,   // ulimit -v, in KB
    cpuSec: 5,      // ulimit -t
  },
  c: {
    filename: 'main.c',
    buildCmd: ['gcc', ['main.c', '-o', 'program']],
    runCmd: ['./program', []],
    memKb: 65536,
    cpuSec: 5,
  },
  cpp: {
    filename: 'main.cpp',
    buildCmd: ['g++', ['main.cpp', '-o', 'program']],
    runCmd: ['./program', []],
    memKb: 98304,
    cpuSec: 5,
  },
  java: {
    filename: 'Main.java',
    buildCmd: ['javac', ['Main.java']],
    runCmd: ['java', ['Main']],
    memKb: 262144,  // JVM baseline overhead is real â€” give it room
    cpuSec: 8,
  },
};

// Dedicated low-privilege user that student code actually runs as, so a
// runaway/malicious submission can't touch the Express process, its env
// vars (DATABASE_URL, JWT_SECRET), or other students' temp files. Created
// in the Dockerfile with `useradd -m -s /usr/sbin/nologin sandbox`.
const SANDBOX_UID = Number(process.env.SANDBOX_UID || 1001);
const SANDBOX_GID = Number(process.env.SANDBOX_GID || 1001);

// Only the deployed container runs this process as root (see Dockerfile),
// which is what makes chown-ing temp files to the `sandbox` user and
// spawning as that uid possible. On local dev (your own Mac/Linux user
// account), there's no permission to do either and no uid 1001 to switch
// to, so we skip privilege-dropping entirely and just run as yourself â€”
// ulimits still apply either way, this only affects the extra user-isolation
// layer, which isn't needed against your own local test runs anyway.
const canDropPrivileges = typeof process.getuid === 'function' && process.getuid() === 0;

const { spawn } = require('child_process');

/**
 * Runs one command as the unprivileged `sandbox` user inside `cwd`, with
 * ulimits applied via a wrapping shell (ulimit is a shell builtin, not a
 * standalone binary, so it has to be set inside `sh -c` before exec'ing
 * the real program). Resolves { code, stdout, stderr, timedOut }.
 */
function runLimited(cwd, memKb, cpuSec, [cmd, args], stdinData = '') {
  return new Promise((resolve) => {
    const quotedArgs = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
    // -v and -u are Linux-only here. -v breaks dyld's shared-library loading
    // on macOS (see above); -u (max processes) is worse on macOS because
    // RLIMIT_NPROC counts every process owned by the user SYSTEM-WIDE, not
    // just this command's subtree â€” any real dev machine already exceeds a
    // limit like 32 before compilation even starts, since Chrome/VS
    // Code/Docker Desktop/etc. all run under the same uid. Both are meaningful
    // and safe on Linux (production), where the container has its own
    // isolated process namespace with nothing else running under that uid.
    const isMac = process.platform === 'darwin';
    const memLimitLine = isMac ? '' : `ulimit -v ${memKb};`;
    const procLimitLine = isMac ? '' : `ulimit -u 32;`;
    const shellLine = `${memLimitLine} ulimit -t ${cpuSec}; ${procLimitLine} ulimit -f 2048; exec ${cmd} ${quotedArgs}`;

    const child = spawn('sh', ['-c', shellLine], {
      cwd,
      ...(canDropPrivileges ? { uid: SANDBOX_UID, gid: SANDBOX_GID } : {}),
      timeout: (cpuSec + 3) * 1000,
      env: { PATH: process.env.PATH },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.on('data', (d) => { if (stdout.length < 1_000_000) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 1_000_000) stderr += d; });
    child.on('error', (err) => resolve({ code: 1, stdout, stderr: err.message, timedOut: false }));
    child.on('close', (code, signal) => {
      if (signal === 'SIGTERM') timedOut = true;
      resolve({ code, stdout, stderr, timedOut });
    });

    child.stdin.write(stdinData ?? '');
    child.stdin.end();
  });
}

/**
 * Runs `code` as the unprivileged `sandbox` user with per-language memory/
 * CPU ulimits, and returns its stdout. No Docker involved â€” this is what
 * lets the whole app run on a plain Render web service with no privileged
 * container access, at the cost of weaker filesystem/network isolation
 * than the old Docker version (acceptable for beginner-level submissions,
 * not a substitute for real container sandboxing against adversarial code).
 */
async function executeInSandboxRaw(language, code, stdin = '') {
  const config = LANGUAGE_CONFIG[language];
  if (!config) {
    return { success: false, timedOut: false, output: '', error: 'Unsupported language' };
  }

  const executionDir = path.join(tempDir, crypto.randomUUID());
  fs.mkdirSync(executionDir, { recursive: true, mode: 0o770 });

  const cleanup = () => {
    if (fs.existsSync(executionDir)) fs.rmSync(executionDir, { recursive: true, force: true });
  };

  try {
    fs.writeFileSync(path.join(executionDir, config.filename), code);
    if (canDropPrivileges) {
      fs.chownSync(executionDir, SANDBOX_UID, SANDBOX_GID);
      fs.chownSync(path.join(executionDir, config.filename), SANDBOX_UID, SANDBOX_GID);
    }
  } catch (err) {
    cleanup();
    return { success: false, timedOut: false, output: '', error: 'Failed to prepare execution files' };
  }

  if (config.buildCmd) {
    const build = await runLimited(executionDir, config.memKb, config.cpuSec, config.buildCmd);
    if (build.code !== 0) {
      cleanup();
      return { success: false, timedOut: build.timedOut, output: '', error: build.stderr || 'Compilation failed' };
    }
  }

  const run = await runLimited(executionDir, config.memKb, config.cpuSec, config.runCmd, stdin);
  cleanup();

  if (run.timedOut) {
    return { success: false, timedOut: true, output: '', error: 'Execution timed out (Infinite loop detected)' };
  }
  if (run.code !== 0) {
    return { success: false, timedOut: false, output: '', error: run.stderr || `Exited with code ${run.code}` };
  }
  return { success: true, timedOut: false, output: run.stdout, error: null };
}

// Caps how many student programs run at once on this instance. Without this,
// a deadline-night burst spawns dozens of compilers/interpreters simultaneously
// and starves the box (and this Express process along with it). Tune the
// number to your Render plan's actual vCPU count â€” don't exceed it for
// compile-heavy languages (C/C++/Java). Requires: npm install p-limit
const pLimit = require('p-limit');
const sandboxLimit = pLimit(Number(process.env.SANDBOX_CONCURRENCY || 4));

function executeInSandbox(language, code, stdin = '') {
  return sandboxLimit(() => executeInSandboxRaw(language, code, stdin));
}

function normalizeOutput(str) {
  return (str ?? '').replace(/\r\n/g, '\n').trim();
}

/**
 * Computes an assignment's availability from its opens_at/closes_at columns.
 * Both are nullable â€” no opens_at means "no start gate", no closes_at means "never closes".
 *   - 'upcoming': before opens_at â€” hidden from students entirely
 *   - 'open':     within the window (or no window at all) â€” visible and submittable
 *   - 'closed':   after closes_at â€” still visible, but read-only for students
 */
function getProblemStatus(problem) {
  const now = new Date();
  if (problem.opens_at && now < new Date(problem.opens_at)) return 'upcoming';
  if (problem.closes_at && now > new Date(problem.closes_at)) return 'closed';
  return 'open';
}

// ============================================================================
// 1. ADMIN ENDPOINT: Create a single student manually
// ============================================================================
app.post('/api/admin/create-student', authenticateToken, requireAdmin, async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  try {
    const rawPassword = generateRandomPassword();
    const hashedPassword = await bcrypt.hash(rawPassword, 10);

    const result = await pool.query(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, $3) RETURNING id, email, role`,
      [email, hashedPassword, 'student']
    );

    res.status(201).json({
      message: 'Student account created successfully',
      student: result.rows[0],
      temporaryPassword: rawPassword,
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Email already exists' });
    }
    console.error('Admin create-student error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// 1b. ADMIN: List every student with a grade/performance summary
// ============================================================================
app.get('/api/admin/students', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.id,
        u.email,
        u.created_at,
        COUNT(DISTINCT s.problem_id) FILTER (WHERE s.status = 'Accepted')::int AS problems_solved,
        COUNT(s.id)::int AS total_submissions,
        MAX(s.created_at) AS last_submission_at
      FROM users u
      LEFT JOIN submissions s ON s.user_id = u.id
      WHERE u.role = 'student'
      GROUP BY u.id, u.email, u.created_at
      ORDER BY u.email ASC
    `);
    res.status(200).json({ students: result.rows });
  } catch (error) {
    console.error('List students error:', error);
    res.status(500).json({ error: 'Failed to load students' });
  }
});

// ============================================================================
// 1c. ADMIN: Per-student breakdown â€” every problem attempted and its result
// ============================================================================
app.get('/api/admin/students/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const studentRes = await pool.query(
      `SELECT id, email, created_at FROM users WHERE id = $1 AND role = 'student'`,
      [req.params.id]
    );
    if (studentRes.rows.length === 0) return res.status(404).json({ error: 'Student not found' });

    const perProblemRes = await pool.query(
      `SELECT
         p.id AS problem_id,
         p.title,
         p.difficulty,
         bool_or(s.status = 'Accepted') AS solved,
         COUNT(s.id)::int AS attempts,
         MAX(s.created_at) AS last_attempt_at
       FROM submissions s
       JOIN problems p ON p.id = s.problem_id
       WHERE s.user_id = $1
       GROUP BY p.id, p.title, p.difficulty
       ORDER BY MAX(s.created_at) DESC`,
      [req.params.id]
    );

    res.status(200).json({ student: studentRes.rows[0], problems: perProblemRes.rows });
  } catch (error) {
    console.error('Student detail error:', error);
    res.status(500).json({ error: 'Failed to load student detail' });
  }
});

// ============================================================================
// 1c-2. ADMIN: Full submission history (including code) for one student on
// one problem â€” lets an admin see exactly what a student tried, in what
// order, and how their code changed between attempts.
// ============================================================================
app.get('/api/admin/students/:studentId/problems/:problemId/submissions', authenticateToken, requireAdmin, async (req, res) => {
  const { studentId, problemId } = req.params;
  try {
    const result = await pool.query(
      `SELECT id, language, code, status, passed_count, total_count, created_at
       FROM submissions
       WHERE user_id = $1 AND problem_id = $2
       ORDER BY created_at DESC`,
      [studentId, problemId]
    );
    res.status(200).json({ submissions: result.rows });
  } catch (error) {
    console.error('Submission history error:', error);
    res.status(500).json({ error: 'Failed to load submission history' });
  }
});

// ============================================================================
// 1d. ADMIN: Remove a student from the platform
// ============================================================================
// Scoped to role = 'student' in the WHERE clause on purpose â€” even if an admin's
// id is passed in here (typo, stale UI, whatever), this 404s instead of touching
// another admin account. There's no route that lets one admin delete another.
app.delete('/api/admin/students/:id', authenticateToken, requireAdmin, async (req, res) => {
  const studentId = req.params.id;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const target = await client.query(
      `SELECT id, email FROM users WHERE id = $1 AND role = 'student'`,
      [studentId]
    );
    if (target.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Student not found' });
    }

    await client.query('DELETE FROM submissions WHERE user_id = $1', [studentId]);
    await client.query('DELETE FROM users WHERE id = $1', [studentId]);

    await client.query('COMMIT');
    res.status(200).json({ message: `${target.rows[0].email} was removed from the platform` });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Delete student error:', error);
    res.status(500).json({ error: 'Failed to remove student' });
  } finally {
    client.release();
  }
});

// ============================================================================
// 2. WEBHOOK ENDPOINT: Automated Onboarding from Google Forms
// (left unauthenticated â€” Google Forms/Zapier can't carry a session cookie)
// ============================================================================
app.post('/api/webhook/google-form', async (req, res) => {
  const { name, email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }

  try {
    const rawPassword = generateRandomPassword();
    const hashedPassword = await bcrypt.hash(rawPassword, 10);

    // ON CONFLICT DO NOTHING means a repeat form submission for an email that
    // already has an account is silently skipped in the DB — but rawPassword
    // above was never saved for that case, so we must NOT email it out, or
    // the student gets a password that doesn't match what's stored. RETURNING
    // tells us whether a row was actually inserted this time.
    const insertResult = await pool.query(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [email, hashedPassword, 'student']
    );

    if (insertResult.rows.length === 0) {
      // Account already existed — don't send a temp password that won't work.
      // Point them at "forgot password" instead, which is the correct flow
      // for an existing account regardless of whether they remember their
      // current password.
      console.log(`â„¹ï¸ Skipped onboarding email for ${email} â€” account already exists`);
      return res.status(200).send('Account already exists, no email sent');
    }

    const { error: emailError } = await resend.emails.send({
      from: EMAIL_FROM,
      to: email,
      subject: 'Your CodeJudge Account Credentials',
      text: `Hello ${name || 'Student'},\n\nYour CodeJudge account is ready!\n\nYour temporary password is: ${rawPassword}\n\nPlease log in and change your password after logging in.`,
    });
    if (emailError) throw emailError;

    console.log(`âœ… Automated Onboarding Complete for: ${email}`);
    res.status(200).send('Success');
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Error processing webhook');
  }
});

// ============================================================================
// 3. AUTH ENDPOINT: Student & Admin Login
// ============================================================================
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);

    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRATION || '24h' }
    );

    res.cookie('token', token, {
      httpOnly: true,
      secure: true,           // must be true for SameSite: 'none' to work — not conditional on NODE_ENV
      sameSite: 'none',
      maxAge: 24 * 60 * 60 * 1000,
    });

    res.status(200).json({
      message: 'Login successful',
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// 3b. SESSION: Who am I? â€” lets the frontend recover role/identity on refresh
// ============================================================================
app.get('/api/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email, role FROM users WHERE id = $1', [req.user.userId]);
    if (result.rows.length === 0) {
      // Token is still valid but the account behind it is gone (e.g. admin removed them)
      res.clearCookie('token');
      return res.status(401).json({ error: 'Session no longer valid' });
    }
    res.status(200).json({ user: result.rows[0] });
  } catch (error) {
    console.error('Get current user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/logout', authenticateToken, (req, res) => {
  res.clearCookie('token');
  res.status(200).json({ message: 'Logged out' });
});

// ============================================================================
// 4. FORGOT PASSWORD: Generate token and send email
// ============================================================================
app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }

  try {
    const userResult = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return res.status(200).json({ message: 'If that email exists, a reset link was sent.' });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
    const tokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Store only the hash â€” like a password, the raw token should never sit in the DB.
    await pool.query(
      'UPDATE users SET reset_token = $1, token_expiry = $2 WHERE email = $3',
      [tokenHash, tokenExpiry, email]
    );

    // This has to point at the frontend (Vite/React app), not the backend API â€”
    // there's no route on port 3000 for a user to actually land on.
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    // App.jsx uses HashRouter, so the route only matches with a /#/ prefix —
    // without it, the browser just loads the SPA shell at "/" and React
    // Router never sees "/reset-password" at all.
    const resetLink = `${frontendUrl}/#/reset-password?token=${resetToken}`;

    const { error: emailError } = await resend.emails.send({
      from: EMAIL_FROM,
      to: email,
      subject: 'CodeJudge Password Reset',
      text: `You requested a password reset.\n\nClick here to reset it: ${resetLink}\n\nThis link expires in 1 hour.`
    });
    if (emailError) throw emailError;

    res.status(200).json({ message: 'If that email exists, a reset link was sent.' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// 5. RESET PASSWORD: Verify token and update password
// ============================================================================
app.post('/api/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({ error: 'Token and new password required' });
  }

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const result = await pool.query(
      'SELECT * FROM users WHERE reset_token = $1 AND token_expiry > NOW()',
      [tokenHash]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const email = result.rows[0].email;
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await pool.query(
      'UPDATE users SET password_hash = $1, reset_token = NULL, token_expiry = NULL WHERE email = $2',
      [hashedPassword, email]
    );

    res.status(200).json({ message: 'Password reset successful. You can now log in.' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// 6. PLAYGROUND â€” free-form code execution, not tied to any problem
// ============================================================================

/**
 * Legacy raw-run endpoint, kept for backward compatibility with the existing
 * "Run Code" button on the problem-solving page. Functionally identical to
 * the Playground route below â€” both just return whatever the program printed.
 */
app.post('/api/execute/:language', authenticateToken, async (req, res) => {
  const { language } = req.params;
  const { code, stdin } = req.body;

  if (!code) return res.status(400).json({ error: 'Code is required' });
  if (!LANGUAGE_CONFIG[language]) return res.status(400).json({ error: 'Unsupported language' });

  const result = await executeInSandbox(language, code, stdin || '');
  if (!result.success) return res.status(400).json({ error: result.error });
  res.status(200).json({ output: result.output });
});

/**
 * The Playground: same sandbox, explicitly namespaced so the frontend can
 * treat it as its own "just write and run code" section, separate from any
 * problem/judge context. Supports optional custom stdin.
 */
app.post('/api/playground/execute/:language', authenticateToken, async (req, res) => {
  const { language } = req.params;
  const { code, stdin } = req.body;

  if (!code) return res.status(400).json({ error: 'Code is required' });
  if (!LANGUAGE_CONFIG[language]) return res.status(400).json({ error: 'Unsupported language' });

  const result = await executeInSandbox(language, code, stdin || '');
  if (!result.success) return res.status(400).json({ error: result.error });
  res.status(200).json({ output: result.output });
});

// ============================================================================
// 7. PROBLEMS â€” LeetCode-style problem bank, browsing, and graded submissions
// ============================================================================

// List all problems (for a problem-list / index page)
app.get('/api/problems', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, title, difficulty, opens_at, closes_at FROM problems ORDER BY id ASC'
    );

    const withStatus = result.rows.map((p) => ({ ...p, status: getProblemStatus(p) }));

    // Students never see an assignment before its opens_at; admins see everything
    // (open, closed, and upcoming) so they can manage the whole set.
    const visible = req.user.role === 'admin'
      ? withStatus
      : withStatus.filter((p) => p.status !== 'upcoming');

    res.status(200).json({ problems: visible });
  } catch (err) {
    console.error('List problems error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Fetch a specific problem, its starter code, and its visible sample test cases
app.get('/api/problems/:id', authenticateToken, async (req, res) => {
  try {
    const problemId = req.params.id;

    const problemRes = await pool.query('SELECT * FROM problems WHERE id = $1', [problemId]);
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Problem not found' });

    const status = getProblemStatus(problemRes.rows[0]);
    if (status === 'upcoming' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'This assignment is not open yet' });
    }

    const codeRes = await pool.query(
      'SELECT language, code FROM starter_code WHERE problem_id = $1',
      [problemId]
    );
    const starterCode = {};
    codeRes.rows.forEach((row) => {
      starterCode[row.language] = row.code;
    });

    // Hidden test cases never leave the server â€” only samples are shown, LeetCode-style
    const sampleRes = await pool.query(
      'SELECT input, expected_output FROM test_cases WHERE problem_id = $1 AND is_hidden = false ORDER BY id ASC',
      [problemId]
    );

    res.json({
      problem: { ...problemRes.rows[0], status },
      starterCode,
      samples: sampleRes.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: upload a new problem with its starter code and test cases in one shot
app.post('/api/admin/problems', authenticateToken, requireAdmin, async (req, res) => {
  const { title, difficulty, description, starterCode = {}, testCases = [], opensAt = null, closesAt = null } = req.body;

  if (!title || !difficulty || !description) {
    return res.status(400).json({ error: 'Title, difficulty, and description are required' });
  }
  if (!Array.isArray(testCases) || testCases.length === 0) {
    return res.status(400).json({ error: 'At least one test case is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const problemRes = await client.query(
      `INSERT INTO problems (title, difficulty, description, created_by, opens_at, closes_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [title, difficulty, description, req.user.userId, opensAt, closesAt]
    );
    const problemId = problemRes.rows[0].id;

    for (const [language, code] of Object.entries(starterCode)) {
      await client.query(
        `INSERT INTO starter_code (problem_id, language, code) VALUES ($1, $2, $3)`,
        [problemId, language, code]
      );
    }

    for (const testCase of testCases) {
      if (!testCase.expectedOutput) continue;
      await client.query(
        `INSERT INTO test_cases (problem_id, input, expected_output, is_hidden)
         VALUES ($1, $2, $3, $4)`,
        [problemId, testCase.input || '', testCase.expectedOutput, testCase.isHidden !== false]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ message: 'Problem created successfully', problemId });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Problem upload error:', error);
    res.status(500).json({ error: 'Failed to create problem' });
  } finally {
    client.release();
  }
});

// ============================================================================
// 7b. ADMIN: Open/close an assignment's time slot
// ============================================================================
// Only touches the field(s) actually present in the body, so you can e.g. close
// an assignment right now without clobbering a previously-scheduled opens_at.
app.patch('/api/admin/problems/:id/window', authenticateToken, requireAdmin, async (req, res) => {
  const problemId = req.params.id;
  const hasOpensAt = Object.prototype.hasOwnProperty.call(req.body, 'opensAt');
  const hasClosesAt = Object.prototype.hasOwnProperty.call(req.body, 'closesAt');

  if (!hasOpensAt && !hasClosesAt) {
    return res.status(400).json({ error: 'Provide opensAt and/or closesAt (send null to clear one)' });
  }

  try {
    const current = await pool.query('SELECT opens_at, closes_at FROM problems WHERE id = $1', [problemId]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Problem not found' });

    const nextOpensAt = hasOpensAt ? req.body.opensAt : current.rows[0].opens_at;
    const nextClosesAt = hasClosesAt ? req.body.closesAt : current.rows[0].closes_at;

    const result = await pool.query(
      `UPDATE problems SET opens_at = $1, closes_at = $2 WHERE id = $3
       RETURNING id, title, opens_at, closes_at`,
      [nextOpensAt, nextClosesAt, problemId]
    );

    const problem = result.rows[0];
    res.status(200).json({ message: 'Assignment window updated', problem: { ...problem, status: getProblemStatus(problem) } });
  } catch (err) {
    console.error('Update assignment window error:', err);
    res.status(500).json({ error: 'Failed to update assignment window' });
  }
});

// ============================================================================
// 7c. ADMIN: Test case management for an existing assignment
// ============================================================================

// List every test case for a problem, hidden ones included (admin-only view)
app.get('/api/admin/problems/:id/test-cases', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, input, expected_output, is_hidden FROM test_cases WHERE problem_id = $1 ORDER BY id ASC',
      [req.params.id]
    );
    res.status(200).json({ testCases: result.rows });
  } catch (err) {
    console.error('List test cases error:', err);
    res.status(500).json({ error: 'Failed to load test cases' });
  }
});

// Add one or more test cases to an existing problem
app.post('/api/admin/problems/:id/test-cases', authenticateToken, requireAdmin, async (req, res) => {
  const problemId = req.params.id;
  const { testCases } = req.body;

  if (!Array.isArray(testCases) || testCases.length === 0) {
    return res.status(400).json({ error: 'At least one test case is required' });
  }

  try {
    const problemRes = await pool.query('SELECT id FROM problems WHERE id = $1', [problemId]);
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Problem not found' });

    const inserted = [];
    for (const tc of testCases) {
      if (!tc.expectedOutput) continue;
      const result = await pool.query(
        `INSERT INTO test_cases (problem_id, input, expected_output, is_hidden)
         VALUES ($1, $2, $3, $4) RETURNING id, input, expected_output, is_hidden`,
        [problemId, tc.input || '', tc.expectedOutput, tc.isHidden !== false]
      );
      inserted.push(result.rows[0]);
    }

    res.status(201).json({ message: `${inserted.length} test case(s) added`, testCases: inserted });
  } catch (err) {
    console.error('Add test cases error:', err);
    res.status(500).json({ error: 'Failed to add test cases' });
  }
});

// Remove a single test case by its own id
app.delete('/api/admin/test-cases/:testCaseId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM test_cases WHERE id = $1 RETURNING id',
      [req.params.testCaseId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Test case not found' });
    res.status(200).json({ message: 'Test case deleted' });
  } catch (err) {
    console.error('Delete test case error:', err);
    res.status(500).json({ error: 'Failed to delete test case' });
  }
});

// ============================================================================
// 7d. ADMIN: Delete an assignment entirely
// ============================================================================
// This is a hard delete â€” it also wipes that problem's starter code, test cases,
// and every student submission tied to it, so grade history for it goes with it.
// If you'd rather keep submission history around, consider closing the time
// slot instead (closesAt in the past) rather than deleting.
app.delete('/api/admin/problems/:id', authenticateToken, requireAdmin, async (req, res) => {
  const problemId = req.params.id;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const problemRes = await client.query('SELECT id, title FROM problems WHERE id = $1', [problemId]);
    if (problemRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Problem not found' });
    }

    await client.query('DELETE FROM submissions WHERE problem_id = $1', [problemId]);
    await client.query('DELETE FROM test_cases WHERE problem_id = $1', [problemId]);
    await client.query('DELETE FROM starter_code WHERE problem_id = $1', [problemId]);
    await client.query('DELETE FROM problems WHERE id = $1', [problemId]);

    await client.query('COMMIT');
    res.status(200).json({ message: `"${problemRes.rows[0].title}" and all related data were deleted` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Delete assignment error:', err);
    res.status(500).json({ error: 'Failed to delete assignment' });
  } finally {
    client.release();
  }
});

// Submit a solution to be graded against every test case for a problem
app.post('/api/problems/:id/submit', authenticateToken, async (req, res) => {
  const problemId = req.params.id;
  const { language, code } = req.body;

  if (!language || !code) {
    return res.status(400).json({ error: 'Language and code are required' });
  }
  if (!LANGUAGE_CONFIG[language]) {
    return res.status(400).json({ error: 'Unsupported language' });
  }

  try {
    const problemRes = await pool.query('SELECT opens_at, closes_at FROM problems WHERE id = $1', [problemId]);
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Problem not found' });

    const status = getProblemStatus(problemRes.rows[0]);
    if (status !== 'open' && req.user.role !== 'admin') {
      return res.status(403).json({
        error: status === 'upcoming' ? 'This assignment is not open yet' : 'This assignment is closed',
      });
    }

    const testCasesRes = await pool.query(
      'SELECT id, input, expected_output, is_hidden FROM test_cases WHERE problem_id = $1 ORDER BY id ASC',
      [problemId]
    );
    const testCases = testCasesRes.rows;

    if (testCases.length === 0) {
      return res.status(404).json({ error: 'No test cases found for this problem' });
    }

    let passedCount = 0;
    let verdict = 'Accepted';
    let failedCase = null;

    // Run sequentially and stop at the first failure â€” mirrors how most judges behave on Submit
    for (const testCase of testCases) {
      const result = await executeInSandbox(language, code, testCase.input);

      if (!result.success) {
        verdict = result.timedOut ? 'Time Limit Exceeded' : 'Runtime Error';
        failedCase = { ...testCase, actualOutput: null, errorMessage: result.error };
        break;
      }

      if (normalizeOutput(result.output) === normalizeOutput(testCase.expected_output)) {
        passedCount += 1;
      } else {
        verdict = 'Wrong Answer';
        failedCase = { ...testCase, actualOutput: result.output };
        break;
      }
    }

    await pool.query(
      `INSERT INTO submissions (user_id, problem_id, language, code, status, passed_count, total_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [req.user.userId, problemId, language, code, verdict, passedCount, testCases.length]
    );

    const response = { verdict, passed: passedCount, total: testCases.length };

    if (failedCase) {
      // Only reveal the actual input/output if the failing case was a visible sample â€”
      // hidden cases stay hidden even on failure, same as a real judge
      response.failedCase = failedCase.is_hidden
        ? { hidden: true }
        : {
            input: failedCase.input,
            expectedOutput: failedCase.expected_output,
            actualOutput: failedCase.actualOutput,
            error: failedCase.errorMessage || null,
          };
    }

    res.status(200).json(response);
  } catch (err) {
    console.error('Submission error:', err);
    res.status(500).json({ error: 'Failed to grade submission' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CodeJudge API running on http://localhost:${PORT}`);
});
