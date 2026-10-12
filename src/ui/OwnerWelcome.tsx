/**
 * The cloud site without an owner link: say what this is and how to get in.
 * There is no register here, and no shop data without the owner's own link.
 */
export function OwnerWelcome() {
  return (
    <main className="lock" aria-label="Welcome">
      <div className="lock__card owner-welcome">
        <span className="brand">CheesyBeez</span>
        <h1 className="lock__title">The owner's page</h1>
        <p>Open the link you were given for this phone. It shows today's takings and anything that needs you, from anywhere.</p>
        <a className="insight__action" href="?demo#owner">See the demo</a>
      </div>
    </main>
  );
}
