export default function DashboardPage() {
  return (
    <main className="flex min-h-screen flex-col p-8">
      <header className="mb-8">
        <h1 className="text-4xl font-bold">Dashboard</h1>
        <p className="text-gray-600 mt-2">Welcome to your TerraBLox dashboard</p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="border rounded-lg p-6">
          <h3 className="text-lg font-semibold mb-2">Total Users</h3>
          <p className="text-3xl font-bold">1,234</p>
        </div>
        <div className="border rounded-lg p-6">
          <h3 className="text-lg font-semibold mb-2">Active Sessions</h3>
          <p className="text-3xl font-bold">567</p>
        </div>
        <div className="border rounded-lg p-6">
          <h3 className="text-lg font-semibold mb-2">Revenue</h3>
          <p className="text-3xl font-bold">$89,012</p>
        </div>
      </div>
    </main>
  );
}

