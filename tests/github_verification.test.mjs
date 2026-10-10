import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { handleStorageRequest } from '../cloudflare/github-storage.mjs';
import { createFakeGitHub, fakeGitHubEnvironment } from './helpers/fake_github.mjs';

const password = 'verification-test-password-only';
const digest = value => createHash('sha256').update(value).digest('hex');
function harness(options = {}) {
  const fake = createFakeGitHub();
  const env = fakeGitHubEnvironment(fake, options.env);
  const messages = [];
  let sender = options.sender || (async (_, message) => { messages.push(message); });
  async function request(route, body) {
    const result = await handleStorageRequest(new Request(`https://write.example/api/storage/auth/${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.10' }, body: JSON.stringify(body),
    }), env, fake.fetch, { sendVerificationEmail: (...args) => sender(...args) });
    return { status: result.status, headers: result.headers, data: await result.json() };
  }
  const path = email => `write-then-publish/registration/${digest(email)}.json`;
  const accountPath = email => `write-then-publish/users/${digest(email)}/account.json`;
  return { fake, env, messages, request, path, accountPath, setSender(value) { sender = value; } };
}

test('registration requires a delivered, mailbox-bound code and atomically consumes it without storing secrets', async () => {
  const context = harness();
  const email = 'verified-writer@example.com';
  assert.equal((await context.request('signup', { email, password })).data.code, 'verification_required');
  assert.equal((await context.request('signup', { email, password, code: '123456' })).data.code, 'verification_required');
  assert.equal(context.fake.snapshotFiles().size, 1, 'failed verification creates no account or pending password');
  const sent = await context.request('signup-code', { email: ` ${email.toUpperCase()} ` });
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.data, { sent: true, expires_in: 600, retry_after: 60 });
  assert.equal(context.messages.length, 1);
  const message = context.messages[0];
  assert.equal(message.email, email);
  assert.match(message.code, /^\d{6}$/);
  const challenge = context.fake.json(context.path(email));
  assert.equal(challenge.delivery_state, 'sent');
  assert.equal(challenge.expires_at - challenge.requested_at, 600);
  assert.equal(challenge.attempts, 0);
  assert.match(challenge.code_hash, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(challenge.code_hash, digest(message.code), 'the low-entropy code is protected by a server HMAC secret');
  for (const content of context.fake.snapshotFiles().values()) {
    const source = Buffer.from(content).toString();
    assert.ok(!source.includes(message.code), 'plaintext code is absent from Git files');
    assert.ok(!source.includes(password));
    assert.ok(!source.includes(context.env.SMTP_PASSWORD));
  }
  assert.ok(!JSON.stringify(sent.data).includes(message.code), 'API never returns a verification code');
  assert.equal((await context.request('signup', { email: 'another-mailbox@example.com', password, code: message.code })).status, 400);
  context.fake.barrierRefUpdates(2);
  const results = await Promise.all([1, 2].map(() => context.request('signup', { email, password, code: message.code })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409], 'concurrent consumption creates exactly one account');
  assert.ok(context.fake.json(context.accountPath(email)).email_verified_at);
  assert.equal(context.fake.text(context.path(email)), null, 'challenge removal and account creation share one commit');
  assert.equal((await context.request('signup', { email, password, code: message.code })).data.code, 'account_exists');
  assert.equal((await context.request('signup-code', { email })).data.code, 'account_exists');
});

test('wrong verification attempts are persisted and the fifth failure invalidates the challenge', async () => {
  const context = harness();
  const email = 'wrong-codes@example.com';
  await context.request('signup-code', { email });
  const correct = context.messages[0].code;
  const wrong = correct === '000000' ? '000001' : '000000';
  for (let attempt = 1; attempt <= 4; attempt++) {
    const result = await context.request('signup', { email, password, code: wrong });
    assert.equal(result.status, 400);
    assert.equal(result.data.code, 'verification_invalid');
    assert.equal(context.fake.json(context.path(email)).attempts, attempt);
  }
  context.fake.barrierRefUpdates(2);
  // One request increments the fifth failure; its competitor retries and observes
  // the persisted lock without resetting or bypassing the attempt counter.
  const final = await Promise.all([1, 2].map(() => context.request('signup', { email, password, code: wrong })));
  assert.deepEqual(final.map(result => result.status), [429, 429]);
  assert.equal(context.fake.json(context.path(email)).attempts, 5);
  assert.equal((await context.request('signup', { email, password, code: correct })).data.code, 'verification_attempts_exceeded');
  assert.equal(context.fake.text(context.accountPath(email)), null);
});

test('codes expire, resend replaces old codes, and persistent per-mailbox limits survive new requests', async () => {
  const originalNow = Date.now;
  let clock = originalNow();
  Date.now = () => clock;
  try {
    const context = harness();
    const email = 'resend-limit@example.com';
    await context.request('signup-code', { email });
    const firstCode = context.messages[0].code;
    const cooldown = await context.request('signup-code', { email });
    assert.equal(cooldown.status, 429);
    assert.equal(cooldown.data.code, 'verification_cooldown');
    assert.equal(cooldown.headers.get('Retry-After'), '60');
    assert.equal(context.messages.length, 1);
    clock += 601000;
    assert.equal((await context.request('signup', { email, password, code: firstCode })).data.code, 'verification_expired');
    await context.request('signup-code', { email });
    assert.notEqual(context.fake.json(context.path(email)).nonce, undefined);
    const newest = context.messages.at(-1).code;
    if (newest !== firstCode) assert.equal((await context.request('signup', { email, password, code: firstCode })).data.code, 'verification_invalid');
    for (let count = 2; count < 6; count++) { clock += 61000; assert.equal((await context.request('signup-code', { email })).status, 200); }
    clock += 61000;
    const limited = await context.request('signup-code', { email });
    assert.equal(limited.status, 429);
    assert.equal(limited.data.code, 'verification_send_limit');
    assert.equal(context.messages.length, 6);
  } finally { Date.now = originalNow; }
});

test('concurrent sends deliver once, and pending/failed delivery cannot create accounts', async () => {
  const concurrent = harness();
  concurrent.fake.barrierRefUpdates(2);
  const sends = await Promise.all([1, 2].map(() => concurrent.request('signup-code', { email: 'parallel-send@example.com' })));
  assert.deepEqual(sends.map(result => result.status).sort(), [200, 429]);
  assert.equal(concurrent.messages.length, 1);

  let finishDelivery, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  let pendingMessage;
  const pending = harness({ sender: async (_, message) => { pendingMessage = message; entered(); await new Promise(resolve => { finishDelivery = resolve; }); } });
  const delivery = pending.request('signup-code', { email: 'pending-mail@example.com' });
  await waiting;
  assert.equal((await pending.request('signup', { email: pendingMessage.email, password, code: pendingMessage.code })).data.code, 'verification_required');
  finishDelivery();
  assert.equal((await delivery).status, 200);

  let failedMessage;
  const failed = harness({ sender: async (_, message) => { failedMessage = message; throw new Error('secret upstream error'); } });
  const result = await failed.request('signup-code', { email: 'failed-mail@example.com' });
  assert.equal(result.status, 503);
  assert.equal(result.data.code, 'email_delivery_failed');
  assert.ok(!JSON.stringify(result.data).includes('secret upstream error'));
  assert.equal(failed.fake.json(failed.path(failedMessage.email)).delivery_state, 'failed');
  assert.equal((await failed.request('signup', { email: failedMessage.email, password, code: failedMessage.code })).data.code, 'verification_required');
  assert.equal(failed.fake.text(failed.accountPath(failedMessage.email)), null);
  const missing = harness({ env: { SMTP_PASSWORD: '' } });
  assert.equal((await missing.request('signup-code', { email: 'missing-config@example.com' })).data.code, 'email_not_configured');
  assert.equal(missing.fake.requests.length, 0, 'missing mail credentials fail before GitHub reads or writes');
});
