"use client";
import { useActionState } from "react";
import { signIn, type LoginState } from "./actions";

export function LoginForm() {
  const [state, action, pending] = useActionState(signIn, {} as LoginState);
  return <form action={action} className="entry-form">
    {state.phone ? <>
      <p>If +{state.phone} is registered as an admin, a six-digit code will arrive on WhatsApp. It expires in five minutes.</p>
      <label>Verification code<input name="code" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required autoFocus /></label>
    </> : <label>WhatsApp number<input name="phone" type="tel" autoComplete="tel" placeholder="+263 77 000 0000" maxLength={32} required /></label>}
    {state.error && <p role="alert" className="form-error">{state.error}</p>}
    <button className="primary" name="intent" value={state.phone ? "verify" : "send"} disabled={pending}>
      {pending ? "Please wait…" : state.phone ? "Verify and sign in" : "Send WhatsApp code"}
    </button>
    {state.phone && <div className="login-links"><button name="intent" value="resend" formNoValidate disabled={pending}>Resend code</button>
      <button name="intent" value="change" formNoValidate disabled={pending}>Change number</button></div>}
  </form>;
}
