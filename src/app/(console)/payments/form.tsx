"use client";
import { useActionState } from "react";
import { savePayment, type EntryState } from "../actions";

type Props = { id: string; today: string; phone: string; methods: readonly string[]; demo: boolean; shippers: { phone: string; name: string }[] };
export function PaymentForm({ id, today, phone, methods, demo, shippers }: Props) {
  const [state, action, pending] = useActionState(savePayment, {} as EntryState);
  const values = state.fields;
  return <form action={action} className="entry-form" aria-label="Record shipper payment">
    <input type="hidden" name="id" value={values?.id ?? state.id ?? id} />
    <label>Shipper WhatsApp number<input name="shipper" type="tel" list="shipper-options" defaultValue={values?.shipper ?? phone} placeholder="+263…" required maxLength={32} /></label>
    <datalist id="shipper-options">{shippers.map(s => <option key={s.phone} value={`+${s.phone}`}>{s.name}</option>)}</datalist>
    <div className="form-pair"><label>Amount (USD)<input name="amount" inputMode="decimal" placeholder="0.00" defaultValue={values?.amount} required pattern="[0-9]{1,6}(\.[0-9]{1,2})?" /></label>
      <label>Payment date<input name="paidOn" type="date" defaultValue={values?.paidOn ?? today} max={today} required /></label></div>
    <label>Method<select name="method" defaultValue={values?.method ?? methods[0]}>{methods.map(m => <option key={m}>{m}</option>)}</select></label>
    <label>Receipt or transaction reference <small>(optional)</small><input name="reference" defaultValue={values?.reference} maxLength={80} /></label>
    {state.error && <p role="alert" className="form-error">{state.error}</p>}
    {state.success && <p role="status" className="form-ok">{state.success}</p>}
    <button className="primary" disabled={demo || pending}>{pending ? "Saving…" : "Record payment"}</button>
    {demo && <small className="subtle">Recording payments requires a signed-in admin.</small>}
  </form>;
}
