import { redirect } from "next/navigation";
import { currentAdmin } from "../session";
import { LoginForm } from "./form";
import { demoMode } from "../../admin";

export default async function Login() {
  if (await currentAdmin()) redirect("/");
  return <main className="login-page"><section className="login-card">
    <span className="wordmark"><i aria-hidden="true">Z</i> Zunde</span>
    <h1>Admin sign-in</h1><p>Use your registered WhatsApp number to access freight operations.</p>
    <LoginForm />{demoMode() && <a className="demo-link" href="/">View sample dashboard</a>}
  </section></main>;
}
