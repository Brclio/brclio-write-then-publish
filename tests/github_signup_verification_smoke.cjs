const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('src/app.js', 'utf8');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `missing ${start}`);
  return source.slice(first, last);
}
const html = fs.readFileSync('index.html', 'utf8');
assert.match(html, /id="accountSignupCodeField" hidden/);
assert.match(html, /id="accountSignupCodeInput"[^>]+autocomplete="one-time-code"[^>]+pattern="\[0-9\]\{6\}"/);
assert.match(html, /id="accountSendSignupCodeBtn"[^>]+type="button"/);

function context(github = true) {
  const calls = [], notices = [], timers = new Map();
  let nextTimer = 0;
  const control = (value = '') => ({ value, hidden: false, required: false, disabled: false, focus() { this.focused = true; },
    setAttribute(name, value) { this[name] = value; }, classList: { toggle() {} } });
  const els = {
    accountEmail: control('new@example.com'), accountPassword: control('password123'), accountPasswordConfirm: control('password123'),
    accountSignupCodeField: control(), accountSignupCode: control(), accountSendSignupCode: control(),
    accountSignIn: control(), accountPasswordConfirmField: control(), accountResendConfirmation: control(), accountSignInMode: control(),
    accountSignUp: control(), accountAuthForm: control(), status: control(),
  };
  const api = { configured: true,
    requestSignupCode: async email => { calls.push({ action: 'send', email }); return { sent: true, expires_in: 600, retry_after: 60 }; },
    signUp: async (...args) => { calls.push({ action: 'signup', args }); return { session: github ? { user: { id: 'new-user' } } : null }; },
  };
  const ctx = {
    els, cloudState: { user: null }, githubStorageEnabled: () => github, cloudApi: () => api,
    Date, console, window: { setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout: id => timers.delete(id) },
    localStorage: { setItem() {} }, sessionStorage: { removeItem() {} }, LAST_ACCOUNT_EMAIL_KEY: 'last', ENTRY_MODE_SESSION_KEY: 'entry',
    setAccountNotice: (message, tone) => notices.push({ message, tone }), setAccountPasswordVisible() {}, refreshGoogleSignInVisibility: async () => {},
    accountAuthErrorMessage: error => error.message, handleCloudSession: async session => { ctx.cloudState.user = session.user; },
    finishEntryChoice: mode => { ctx.mode = mode; }, setPendingConfirmation() {}, closeAccountModal() {},
  };
  vm.createContext(ctx);
  vm.runInContext([
    section('let accountAuthMode =', 'function accountSessionSnapshot('),
    section('function setAccountAuthMode(', 'function accountAuthErrorMessage('),
    section('function setAccountBusy(', 'function updateAccountUi('),
    section('async function signUpAccount()', 'async function resendAccountConfirmation()'),
  ].join('\n'), ctx);
  return { ctx, els, api, calls, notices, timers };
}

(async () => {
  const github = context();
  github.ctx.setAccountAuthMode('signup');
  assert.equal(github.els.accountSignupCodeField.hidden, false);
  assert.equal(github.els.accountSignupCode.required, true);
  await github.ctx.signUpAccount();
  assert.equal(github.calls.length, 0, 'registration cannot skip the six-digit code');
  assert.match(github.notices.at(-1).message, /6 位/);
  github.els.accountEmail.value = 'invalid';
  await github.ctx.sendGitHubSignupCode();
  assert.equal(github.calls.length, 0);
  github.els.accountEmail.value = 'NEW@example.com';
  await github.ctx.sendGitHubSignupCode();
  assert.deepEqual(github.calls, [{ action: 'send', email: 'new@example.com' }], 'sending only submits the email, without a password');
  assert.equal(github.els.accountSendSignupCode.disabled, true);
  assert.match(github.els.accountSendSignupCode.textContent, /^60s$/);
  assert.match(github.notices.at(-1).message, /10 分钟/);
  await github.ctx.sendGitHubSignupCode();
  assert.equal(github.calls.length, 1, 'cooldown stops repeated send requests');
  github.els.accountSignupCode.value = '123456';
  await github.ctx.signUpAccount();
  assert.deepEqual(github.calls.at(-1).args, ['NEW@example.com', 'password123', '123456']);
  assert.equal(github.ctx.mode, 'account');
  assert.equal(github.els.accountSignupCode.value, '');
  github.ctx.setAccountAuthMode('signin');
  assert.equal(github.els.accountSignupCodeField.hidden, true);
  assert.equal(github.els.accountSignupCode.required, false);

  const invalid = context();
  invalid.ctx.setAccountAuthMode('signup'); invalid.els.accountSignupCode.value = '654321';
  invalid.api.signUp = async () => { const error = new Error('验证码已过期，请重新发送。'); error.code = 'verification_expired'; throw error; };
  await invalid.ctx.signUpAccount();
  assert.equal(invalid.ctx.cloudState.user, null);
  assert.equal(invalid.els.accountPassword.value, 'password123', 'failed code verification keeps the form available for correction');
  assert.match(invalid.notices.at(-1).message, /过期/);
  invalid.api.requestSignupCode = async () => { const error = new Error('请等待再重新发送。'); error.code = 'verification_cooldown'; error.retryAfter = 17; throw error; };
  await invalid.ctx.sendGitHubSignupCode();
  assert.equal(invalid.els.accountSendSignupCode.disabled, true);
  assert.match(invalid.els.accountSendSignupCode.textContent, /^17s$/);
  invalid.els.accountEmail.value = 'another@example.com'; invalid.ctx.updateGitHubSignupVerificationUi();
  assert.equal(invalid.els.accountSendSignupCode.disabled, false, 'a different email can request its own verification code');

  const supabase = context(false);
  supabase.ctx.updateGitHubSignupVerificationUi(); supabase.ctx.setAccountAuthMode('signup');
  assert.equal(supabase.els.accountSignupCodeField.hidden, true);
  assert.equal(supabase.els.accountSignupCode.required, false);
  await supabase.ctx.signUpAccount();
  assert.deepEqual(supabase.calls[0].args, ['new@example.com', 'password123'], 'default Supabase registration keeps its existing two-argument contract');
  await supabase.ctx.sendGitHubSignupCode();
  assert.equal(supabase.calls.length, 1, 'the GitHub-only email endpoint is never called in the default mode');
  console.log('OK: GitHub-only email verification UI, six-digit registration, cooldown, correction errors and unchanged Supabase signup');
})().catch(error => { console.error(error); process.exitCode = 1; });
