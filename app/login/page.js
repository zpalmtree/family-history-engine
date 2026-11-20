import { authIsConfigured, sanitizeReturnTo } from "../../lib/viewer-auth.js";
import branding from "../../lib/viewer-branding.js";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }) {
  const params = await searchParams;
  const returnTo = sanitizeReturnTo(params?.returnTo);
  const hasError = params?.error === "invalid";
  const configured = authIsConfigured();
  return (
    <main className="login-shell">
      <section className="login-card" aria-labelledby="login-title">
        <p className="login-kicker">Private family archive</p>
        <h1 id="login-title">{branding.title}</h1>
        <p className="login-copy">Enter the shared family passphrase to view the tree.</p>
        {!configured ? (
          <p className="login-message error" role="alert">The private viewer has not been configured yet.</p>
        ) : (
          <form action="/api/login" method="post" className="login-form">
            <input type="hidden" name="returnTo" value={returnTo} />
            <input type="text" name="username" value="family-tree" autoComplete="username" readOnly hidden />
            <label htmlFor="password">Family passphrase</label>
            <input id="password" name="password" type="password" autoComplete="current-password" required autoFocus />
            {hasError ? <p className="login-message error" role="alert">That passphrase was not accepted.</p> : null}
            <button type="submit">View family tree</button>
          </form>
        )}
        <p className="login-privacy">This browser will remain signed in until you log out or clear its site data.</p>
      </section>
    </main>
  );
}
