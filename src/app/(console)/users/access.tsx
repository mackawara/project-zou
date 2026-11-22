"use client";
import { useActionState } from "react";
import { saveAccess, type EntryState } from "../actions";
export function AccessForm({ phone, suspended, demo }: { phone: string; suspended: boolean; demo: boolean }) {
  const [state, action, pending] = useActionState(saveAccess, {} as EntryState);
  const label = suspended ? "Reinstate" : "Suspend";
  return <details className="access-control"><summary>{label} shipper</summary><form action={action} className="entry-form">
    <input type="hidden" name="shipper" value={phone} /><input type="hidden" name="action" value={suspended ? "reinstate" : "suspend"} />
    <p>{suspended ? "Restore searches, matches and new bookings." : "Pause searches, matches and new bookings. Existing deliveries can still be completed."}</p>
    <label>Reason<input name="reason" required maxLength={200} /></label>
    <button className={suspended ? "primary" : "danger"} disabled={demo || pending}>{pending ? "Saving…" : `Confirm ${suspended ? "reinstatement" : "suspension"}`}</button>
    {demo && <small>Account changes require a signed-in admin.</small>}
    {state.error && <p role="alert" className="form-error">{state.error}</p>}
    {state.success && <p role="status" className="form-ok">{state.success}</p>}
  </form></details>;
}
