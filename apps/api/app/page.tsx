export default function ApiHomePage() {
  return (
    <main className="p-8">
      <h1 className="text-2xl font-bold mb-4">TerraBLox API</h1>
      <p className="mb-4">API is running. See documentation for available endpoints.</p>
      <ul className="list-disc list-inside space-y-2">
        <li>/api/auth/* - Authentication endpoints</li>
        <li>/api/users/* - User management</li>
        <li>/api/data/* - Data operations</li>
        <li>/api/webhooks/* - Webhook handlers</li>
      </ul>
    </main>
  );
}

