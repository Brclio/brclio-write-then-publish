// Gmail's implicit TLS SMTP endpoint is supported by Workers TCP sockets.
// Credentials are runtime secrets; protocol errors never include server replies.
const encoder = new TextEncoder();
const SMTP_TIMEOUT_MS = 20000;

export class EmailError extends Error {
  constructor(message, code = 'email_delivery_failed') { super(message); this.code = code; }
}

function emailAddress(value) {
  return typeof value === 'string' && value.length <= 254
    && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value);
}

export function smtpConfiguration(env) {
  const host = env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(env.SMTP_PORT || 465);
  const username = env.SMTP_USERNAME;
  const from = env.SMTP_FROM || username;
  const password = typeof env.SMTP_PASSWORD === 'string' ? env.SMTP_PASSWORD.replace(/[ \t]/g, '') : '';
  if (typeof host !== 'string' || !/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(host)
      || port !== 465 || !emailAddress(username) || !emailAddress(from)
      || !password || password.length > 256 || /[\x00-\x20\x7f]/.test(password)) {
    throw new EmailError('注册邮件服务尚未配置完整，请联系站点管理员。', 'email_not_configured');
  }
  return { host, port, username, password, from };
}

function base64(value) {
  let text = '';
  for (const byte of encoder.encode(value)) text += String.fromCharCode(byte);
  return btoa(text);
}

export function verificationMessage({ from, email, code, expiresMinutes = 10 }) {
  if (!emailAddress(from) || !emailAddress(email) || !/^\d{6}$/.test(code)) throw new EmailError('注册邮件参数无效。');
  const subject = `=?UTF-8?B?${base64('写了就发 · 注册验证码')}?=`;
  const body = `你正在注册「写了就发」。\n\n邮箱验证码：${code}\n\n验证码 ${expiresMinutes} 分钟内有效，只能使用一次。请勿向他人透露。\n如果你没有发起注册，请忽略这封邮件。\n`;
  return [
    `From: =?UTF-8?B?${base64('写了就发')}?= <${from}>`, `To: <${email}>`,
    `Subject: ${subject}`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@write.brclio.com>`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    base64(body).match(/.{1,76}/g).join('\r\n'), '',
  ].join('\r\n');
}

async function cloudflareConnect(address, options) {
  const { connect } = await import('cloudflare:sockets');
  return connect(address, options);
}

export async function sendVerificationEmail(env, message, connector = cloudflareConnect) {
  const configuration = smtpConfiguration(env);
  const data = verificationMessage({ ...message, from: configuration.from });
  let socket, reader, writer, timer;
  const run = async () => {
    socket = await connector({ hostname: configuration.host, port: configuration.port }, { secureTransport: 'on' });
    socket.closed?.catch(() => {});
    if (socket.opened) await socket.opened;
    reader = socket.readable.getReader();
    writer = socket.writable.getWriter();
    const decoder = new TextDecoder();
    let buffer = '';
    async function line() {
      while (!buffer.includes('\r\n')) {
        const { value, done } = await reader.read();
        if (done) throw new EmailError('邮件服务连接提前结束，请稍后重试。');
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 65536) throw new EmailError('邮件服务响应无效，请稍后重试。');
      }
      const end = buffer.indexOf('\r\n');
      const result = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      return result;
    }
    async function reply(expected) {
      let code;
      for (let count = 0; count < 100; count++) {
        const result = (await line()).match(/^(\d{3})([- ])(.*)$/);
        if (!result || (code && code !== result[1])) throw new EmailError('邮件服务响应无效，请稍后重试。');
        code = result[1];
        if (result[2] === ' ') {
          if (Number(code) !== expected) throw new EmailError('注册邮件发送失败，请稍后重试或联系站点管理员。');
          return;
        }
      }
      throw new EmailError('邮件服务响应无效，请稍后重试。');
    }
    async function command(value, expected) { await writer.write(encoder.encode(`${value}\r\n`)); await reply(expected); }
    await reply(220);
    await command('EHLO write.brclio.com', 250);
    await command('AUTH LOGIN', 334);
    await command(base64(configuration.username), 334);
    await command(base64(configuration.password), 235);
    await command(`MAIL FROM:<${configuration.from}>`, 250);
    await command(`RCPT TO:<${message.email}>`, 250);
    await command('DATA', 354);
    await command(`${data}.`, 250);
    // Acceptance after DATA is the delivery boundary. A failed QUIT must not
    // mark an already accepted message as unsent.
    try { await writer.write(encoder.encode('QUIT\r\n')); } catch { /* Accepted. */ }
  };
  try {
    await Promise.race([run(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new EmailError('邮件服务连接超时，请稍后重试。')), SMTP_TIMEOUT_MS);
    })]);
  } catch (error) {
    if (error instanceof EmailError) throw error;
    throw new EmailError('注册邮件发送失败，请稍后重试或联系站点管理员。');
  } finally {
    clearTimeout(timer);
    try { socket?.close()?.catch(() => {}); } catch { /* Best effort close. */ }
    try { reader?.releaseLock(); } catch { /* A timed-out read can still be pending. */ }
    try { writer?.releaseLock(); } catch { /* A timed-out write can still be pending. */ }
  }
}
