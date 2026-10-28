// The sign-in flow pieces, shared by the sign-in screen and the invite landing.
// Real <form>s with autocomplete attributes so password managers work; every
// primary action shows loading, validation and failure; nothing says "done" before
// the server confirmed.
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { humanError } from '../../api/errors';
import { actions } from '../../store';
import { CODE_LENGTH, CodeError, isMailProblem } from '../../sync/auth';
import { Banner, Button, TextField } from '../../ui/kit';

const RESEND_SECONDS = 60;

export type CodePurpose = 'signin' | 'reset';

type Step =
  | { name: 'password' }
  | { name: 'code-request'; purpose: CodePurpose }
  | { name: 'code-verify'; purpose: CodePurpose; email: string; wait: number; notice: string | null };

export interface SignInFlowProps {
  heading?: string;
  lead?: string;
  onSignedIn?: () => void;
  // The invite being accepted: lets a person without an account get a code.
  inviteCode?: string;
}

// Password first (it always works); email codes as the second way in, and the
// route to "forgot password".
export function SignInFlow({ heading = 'Sign in to Dek', lead, onSignedIn, inviteCode }: SignInFlowProps) {
  const [step, setStep] = useState<Step>({ name: 'password' });
  const [email, setEmail] = useState('');

  if (step.name === 'password') {
    return (
      <PasswordForm
        heading={heading}
        lead={lead}
        email={email}
        onEmail={setEmail}
        onSignedIn={onSignedIn}
        onCode={() => setStep({ name: 'code-request', purpose: 'signin' })}
        onForgot={() => setStep({ name: 'code-request', purpose: 'reset' })}
      />
    );
  }
  if (step.name === 'code-request') {
    return (
      <CodeRequestForm
        purpose={step.purpose}
        email={email}
        inviteCode={inviteCode}
        onEmail={setEmail}
        onSent={(e, wait, notice) => setStep({ name: 'code-verify', purpose: step.purpose, email: e, wait, notice })}
        onBack={() => setStep({ name: 'password' })}
      />
    );
  }
  return (
    <CodeVerifyForm
      purpose={step.purpose}
      email={step.email}
      inviteCode={inviteCode}
      wait={step.wait}
      initialNotice={step.notice}
      onVerified={onSignedIn}
      onChangeEmail={() => setStep({ name: 'code-request', purpose: step.purpose })}
      onUsePassword={() => setStep({ name: 'password' })}
    />
  );
}

// ---------------------------------------------------------------- password

interface PasswordFormProps {
  heading: string;
  lead?: string;
  email: string;
  onEmail: (v: string) => void;
  onSignedIn?: () => void;
  onCode: () => void;
  onForgot: () => void;
}

function PasswordForm({ heading, lead, email, onEmail, onSignedIn, onCode, onForgot }: PasswordFormProps) {
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ email?: string; password?: string }>({});
  const passwordId = useId();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const next: { email?: string; password?: string } = {};
    if (!email.trim()) next.email = 'Enter your email address.';
    if (!password) next.password = 'Enter your password.';
    setFieldError(next);
    if (next.email || next.password) return;
    setBusy(true);
    setError(null);
    try {
      await actions.signInWithPassword(email, password);
      onSignedIn?.();
    } catch (err) {
      setError(humanError(err));
      setBusy(false);
    }
  };

  // Enter in the email field moves to the password field (LESSONS "Auth").
  const onEmailKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing && !password) {
      e.preventDefault();
      document.getElementById(passwordId)?.focus();
    }
  };

  return (
    <form className="dk-auth__form" onSubmit={submit} noValidate aria-describedby={error ? 'dk-auth-err' : undefined}>
      <h1 className="dk-auth__title">{heading}</h1>
      {lead ? <p className="dk-auth__lead">{lead}</p> : null}
      <TextField
        label="Email"
        type="email"
        name="email"
        autoComplete="username"
        inputMode="email"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={email}
        onChange={(e) => onEmail(e.target.value)}
        onKeyDown={onEmailKey}
        error={fieldError.email ?? null}
        disabled={busy}
      />
      <TextField
        id={passwordId}
        label="Password"
        type={show ? 'text' : 'password'}
        name="password"
        autoComplete="current-password"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={fieldError.password ?? null}
        disabled={busy}
      />
      <label className="dk-auth__check">
        <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
        Show password
      </label>
      {error ? <div id="dk-auth-err"><Banner tone="danger">{error}</Banner></div> : null}
      <Button type="submit" variant="primary" size="lg" block loading={busy}>Sign in</Button>
      <button type="button" className="dk-auth__link" onClick={onForgot} disabled={busy}>Forgot password?</button>
      <div className="dk-auth__or" aria-hidden="true">or</div>
      <Button variant="secondary" size="lg" block onClick={onCode} disabled={busy}>Email me a sign-in code</Button>
    </form>
  );
}

// ---------------------------------------------------------------- code request

interface CodeRequestFormProps {
  purpose: CodePurpose;
  email: string;
  inviteCode?: string;
  onEmail: (v: string) => void;
  onSent: (email: string, wait: number, notice: string | null) => void;
  onBack: () => void;
}

function CodeRequestForm({ purpose, email, inviteCode, onEmail, onSent, onBack }: CodeRequestFormProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mailDown, setMailDown] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!email.trim()) {
      setError('Enter your email address.');
      return;
    }
    setBusy(true);
    setError(null);
    setMailDown(false);
    try {
      await actions.sendEmailCode(email, { purpose, inviteCode: inviteCode ?? null });
      onSent(email.trim(), RESEND_SECONDS, null);
    } catch (err) {
      if (err instanceof CodeError && err.reason === 'too_soon') {
        // A code went out a moment ago: use that one.
        onSent(email.trim(), err.retryAfter ?? RESEND_SECONDS, 'We sent you a code a moment ago. Use the code from that email.');
        return;
      }
      setError(humanError(err));
      setMailDown(isMailProblem(err));
      setBusy(false);
    }
  };

  return (
    <form className="dk-auth__form" onSubmit={submit} noValidate>
      <h1 className="dk-auth__title">{purpose === 'reset' ? 'Reset your password' : 'Sign in with a code'}</h1>
      <p className="dk-auth__lead">
        {purpose === 'reset'
          ? `We will email you a ${CODE_LENGTH}-digit code. After you enter it you can choose a new password.`
          : inviteCode
            ? `We will email you a ${CODE_LENGTH}-digit code. New to Dek? This also creates your account.`
            : `We will email a ${CODE_LENGTH}-digit sign-in code to your Dek address.`}
      </p>
      <TextField
        label="Email"
        type="email"
        name="email"
        autoComplete="username"
        inputMode="email"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={email}
        onChange={(e) => onEmail(e.target.value)}
        disabled={busy}
      />
      {error ? (
        <Banner tone={mailDown ? 'warning' : 'danger'} action={mailDown ? <Button size="sm" variant="ghost" onClick={onBack}>Use password</Button> : undefined}>
          {error}
        </Banner>
      ) : null}
      <Button type="submit" variant="primary" size="lg" block loading={busy}>Send code</Button>
      <button type="button" className="dk-auth__link" onClick={onBack} disabled={busy}>Back to password sign-in</button>
    </form>
  );
}

// ---------------------------------------------------------------- code verify

interface CodeVerifyFormProps {
  purpose: CodePurpose;
  email: string;
  inviteCode?: string;
  wait: number;
  initialNotice: string | null;
  onVerified?: () => void;
  onChangeEmail: () => void;
  onUsePassword: () => void;
}

function CodeVerifyForm({ purpose, email, inviteCode, wait, initialNotice, onVerified, onChangeEmail, onUsePassword }: CodeVerifyFormProps) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(initialNotice);
  const [left, setLeft] = useState(Math.max(0, Math.round(wait)));
  const tried = useRef<string | null>(null);
  const codeId = useId();

  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((n) => n - 1), 1_000);
    return () => clearTimeout(t);
  }, [left]);

  useEffect(() => {
    document.getElementById(codeId)?.focus();
  }, [codeId]);

  const verify = useCallback(async (value: string) => {
    if (busy || value.length !== CODE_LENGTH || tried.current === value) return;
    tried.current = value;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await actions.verifyEmailCode(email, value);
      onVerified?.();
    } catch (err) {
      // Only a wrong code is final for this value: after a network blip, a server error
      // or a rate limit the same code must be submittable again.
      if (!(err instanceof CodeError && err.reason === 'wrong_code')) tried.current = null;
      const tries = err instanceof CodeError && err.reason === 'wrong_code' ? err.attemptsLeft : null;
      setError(tries !== null && tries >= 0
        ? `${humanError(err)} ${tries === 0 ? 'That was the last try: ask for a new code.' : `${tries} ${tries === 1 ? 'try' : 'tries'} left.`}`
        : humanError(err));
      setBusy(false);
    }
  }, [busy, email, onVerified]);

  const resend = async () => {
    if (left > 0 || busy) return;
    setError(null);
    setNotice(null);
    try {
      await actions.sendEmailCode(email, { purpose, inviteCode: inviteCode ?? null });
      setNotice('A new code is on its way. Use the newest email.');
      setLeft(RESEND_SECONDS);
      tried.current = null;
      setCode('');
    } catch (err) {
      if (err instanceof CodeError && err.retryAfter) setLeft(Math.round(err.retryAfter));
      setError(humanError(err));
    }
  };

  return (
    <form className="dk-auth__form" onSubmit={(e) => { e.preventDefault(); void verify(code); }} noValidate>
      <h1 className="dk-auth__title">Check your email</h1>
      <p className="dk-auth__lead">If <strong>{email}</strong> has a Dek account, we sent it a {CODE_LENGTH}-digit code. It works for 10 minutes. Nothing after a minute? Check the address and the spam folder.</p>
      <TextField
        id={codeId}
        label={`${CODE_LENGTH}-digit code`}
        name="code"
        className="dk-auth__code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={CODE_LENGTH}
        value={code}
        disabled={busy}
        onChange={(e) => {
          const v = e.target.value.replace(/\D/g, '').slice(0, CODE_LENGTH);
          setCode(v);
          if (v.length === CODE_LENGTH) void verify(v);   // auto-verify on the last digit
        }}
      />
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {notice ? <Banner tone="success">{notice}</Banner> : null}
      <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={code.length !== CODE_LENGTH}>
        {purpose === 'reset' ? 'Verify and choose a password' : 'Verify and sign in'}
      </Button>
      <div className="dk-auth__row">
        <button type="button" className="dk-auth__link" onClick={() => void resend()} disabled={left > 0 || busy} aria-live="polite">
          {left > 0 ? `Resend code in ${left} s` : 'Resend code'}
        </button>
        <button type="button" className="dk-auth__link" onClick={onChangeEmail} disabled={busy}>Use a different email</button>
      </div>
      <button type="button" className="dk-auth__link" onClick={onUsePassword} disabled={busy}>Sign in with a password instead</button>
    </form>
  );
}

// ---------------------------------------------------------------- set password

export function SetPasswordForm({ mode, email }: { mode: 'password' | 'reset'; email: string | null }) {
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (password.trim().length < 8) {
      setError('Use at least 8 characters.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await actions.setPassword(password);
    } catch (err) {
      setError(humanError(err));
      setBusy(false);
    }
  };

  return (
    <form className="dk-auth__form" onSubmit={submit} noValidate>
      <h1 className="dk-auth__title">{mode === 'reset' ? 'Choose a new password' : 'Set a password'}</h1>
      <p className="dk-auth__lead">
        {mode === 'reset'
          ? 'You are signed in. Choose the password you will use next time.'
          : 'You are signed in. A password lets you sign in next time without waiting for an email.'}
      </p>
      {/* Password managers file the new password against this username. */}
      <TextField label="Email" type="email" name="username" autoComplete="username" value={email ?? ''} readOnly className="dk-auth__readonly" />
      <TextField
        label="New password"
        type={show ? 'text' : 'password'}
        name="new-password"
        autoComplete="new-password"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        minLength={8}
        hint="At least 8 characters."
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        disabled={busy}
      />
      <label className="dk-auth__check">
        <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
        Show password
      </label>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <Button type="submit" variant="primary" size="lg" block loading={busy}>Save password</Button>
      <Button variant="ghost" block onClick={() => actions.skipSetup()} disabled={busy}>
        {mode === 'reset' ? 'Not now' : 'Skip for now'}
      </Button>
    </form>
  );
}
