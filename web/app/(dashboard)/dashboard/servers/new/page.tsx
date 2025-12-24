"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createServer } from "@/actions/servers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function NewServerPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    id: string;
    name: string;
    agentToken: string;
  } | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    const server = await createServer(name);
    setResult(server);
    setLoading(false);
  }

  if (result) {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Server Created</CardTitle>
            <CardDescription>
              Install the agent on your server using the token below
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Server Name</Label>
              <p className="text-sm font-medium">{result.name}</p>
            </div>
            <div className="space-y-2">
              <Label>Agent Token</Label>
              <div className="relative">
                <code className="block p-3 bg-muted rounded-lg text-sm break-all font-mono">
                  {result.agentToken}
                </code>
              </div>
              <p className="text-xs text-muted-foreground">
                This token expires in 24 hours and can only be used once.
              </p>
            </div>
            <div className="space-y-2">
              <Label>Install Command</Label>
              <code className="block p-3 bg-muted rounded-lg text-sm break-all font-mono">
                curl -fsSL https://your-domain/install.sh | bash -s -- --token {result.agentToken}
              </code>
            </div>
          </CardContent>
          <CardFooter>
            <Button onClick={() => router.push("/dashboard")}>
              Done
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto">
      <Card>
        <CardHeader>
          <CardTitle>Add Server</CardTitle>
          <CardDescription>
            Register a new server to your fleet
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Server Name</Label>
              <Input
                id="name"
                placeholder="production-1"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
          </CardContent>
          <CardFooter className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => router.push("/dashboard")}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? "Creating..." : "Create Server"}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
