import assert from 'node:assert/strict';
import test from 'node:test';
import { EmailError, sendVerificationEmail, smtpConfiguration, verificationMessage } from '../cloudflare/smtp.mjs';

const env = { SMTP_USERNAME: 'sender@example.com', SMTP_PASSWORD: 'test-only-app-password' };
const message = { email: 'recipient@example.com', code: '123456', expiresMinutes: 10 };
function smtpServer(options = {}) {
  const commands = [];
  let input = '', dataMode = false, body = '', closed = false;
  let controller;
  const readable = new ReadableStream({ start(value) { controller = value; } });
  const emit = line => {
    const bytes = new TextEncoder().encode(`${line}\r\n`);
    controller.enqueue(bytes.subarray(0, 3));
    controller.enqueue(bytes.subarray(3));
  };
  emit('220 smtp.example ready');
  const writable = new WritableStream({
    write(bytes) {
      input += new TextDecoder().decode(bytes);
      let end;
      while ((end = input.indexOf('\r\n')) >= 0) {
        const line = input.slice(0, end); input = input.slice(end + 2);
        if (dataMode) {
          if (line === '.') { dataMode = false; emit(options.rejectData ? '554 rejected secret server detail' : '250 queued'); }
          else body += `${line}\r\n`;
          continue;
        }
        commands.push(line);
        if (line.startsWith('EHLO ')) { emit('250-smtp.example'); emit('250-AUTH LOGIN PLAIN'); emit('250 SIZE 10485760'); }
        else if (line === 'AUTH LOGIN') emit('334 VXNlcm5hbWU6');
        else if (line === btoa(env.SMTP_USERNAME)) emit('334 UGFzc3dvcmQ6');
        else if (line === btoa(env.SMTP_PASSWORD)) emit(options.rejectAuth ? '535 secret authorization failure' : '235 accepted');
        else if (line.startsWith('MAIL FROM:') || line.startsWith('RCPT TO:')) emit('250 accepted');
        else if (line === 'DATA') { dataMode = true; emit('354 end with dot'); }
        else if (line === 'QUIT') { if (options.rejectQuit) throw new Error('QUIT write failed'); }
        else throw new Error('Unexpected command');
      }
    },
  });
  return {
    commands, get body() { return body; }, get closed() { return closed; },
    connector: async (address, socketOptions) => {
      assert.deepEqual(address, { hostname: 'smtp.gmail.com', port: 465 });
      assert.deepEqual(socketOptions, { secureTransport: 'on' });
      return { opened: Promise.resolve(), closed: Promise.resolve(), readable, writable, async close() { closed = true; controller.close(); } };
    },
  };
}

test('Gmail SMTP uses TLS 465, handles fragmented multiline replies, and creates a UTF-8 verification message', async () => {
  const server = smtpServer();
  await sendVerificationEmail(env, message, server.connector);
  assert.equal(server.closed, true);
  assert.deepEqual(server.commands.slice(0, 3), ['EHLO write.brclio.com', 'AUTH LOGIN', btoa(env.SMTP_USERNAME)]);
  assert.ok(server.commands.includes('MAIL FROM:<sender@example.com>'));
  assert.ok(server.commands.includes('RCPT TO:<recipient@example.com>'));
  assert.match(server.body, /Content-Transfer-Encoding: base64/);
  const body = Buffer.from(server.body.split('\r\n\r\n')[1].replace(/\s/g, ''), 'base64').toString();
  assert.match(body, /验证码：123456/);
  assert.match(body, /10 分钟/);
  assert.ok(!server.body.includes(env.SMTP_PASSWORD));
});

test('mail configuration and addresses reject unsafe inputs before opening a socket', async () => {
  assert.equal(smtpConfiguration({ ...env, SMTP_PASSWORD: 'test only app password' }).password, 'testonlyapppassword');
  for (const overrides of [{ SMTP_PORT: '25' }, { SMTP_PORT: '587' }, { SMTP_HOST: 'smtp.gmail.com\r\nX' }, { SMTP_USERNAME: 'sender@example.com\r\nBcc:x@evil.test' }, { SMTP_PASSWORD: '' }, { SMTP_FROM: 'bad' }]) {
    assert.throws(() => smtpConfiguration({ ...env, ...overrides }), error => error instanceof EmailError && error.code === 'email_not_configured');
  }
  let connections = 0;
  await assert.rejects(sendVerificationEmail(env, { ...message, email: 'recipient@example.com\r\nBcc:other@example.com' }, () => { connections++; }), EmailError);
  assert.equal(connections, 0);
  assert.throws(() => verificationMessage({ from: env.SMTP_USERNAME, ...message, code: '123456\r\n' }), EmailError);
});

test('SMTP failures are sanitized, sockets are closed, and accepted delivery survives QUIT failure', async () => {
  for (const flag of ['rejectAuth', 'rejectData']) {
    const server = smtpServer({ [flag]: true });
    await assert.rejects(sendVerificationEmail(env, message, server.connector), error => error.code === 'email_delivery_failed' && !error.message.includes('secret'));
    assert.equal(server.closed, true);
  }
  const accepted = smtpServer({ rejectQuit: true });
  await sendVerificationEmail(env, message, accepted.connector);
  assert.equal(accepted.closed, true);
  await assert.rejects(sendVerificationEmail(env, message, async () => { throw new Error('sensitive transport details'); }), error => !error.message.includes('sensitive'));
});
