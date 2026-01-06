import { Button } from "@terrablox/ui/button";
import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <div className="text-center">
        <h1 className="text-6xl font-bold mb-6">TerraBLox</h1>
        <p className="text-xl text-gray-600 mb-8">Open Source SaaS Platform</p>
        <div className="flex gap-4 justify-center">
          <Link href={process.env.NEXT_PUBLIC_DASHBOARD_URL || "/dashboard"}>
            <Button size="lg">Get Started</Button>
          </Link>
          <Button variant="outline" size="lg">
            Learn More
          </Button>
        </div>
      </div>
    </main>
  );
}
