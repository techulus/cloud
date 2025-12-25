"use client";

import { useState, use } from "react";
import { useRouter } from "next/navigation";
import { createService } from "@/actions/projects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function NewServicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: projectId } = use(params);
  const router = useRouter();
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [ports, setPorts] = useState("80");
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !image.trim()) return;

    const portNumbers = ports
      .split(",")
      .map((p) => parseInt(p.trim()))
      .filter((p) => !isNaN(p) && p > 0);

    if (portNumbers.length === 0) return;

    setIsLoading(true);
    try {
      await createService(projectId, name.trim(), image.trim(), portNumbers);
      router.push(`/dashboard/projects/${projectId}`);
    } catch (error) {
      console.error("Failed to create service:", error);
      setIsLoading(false);
    }
  };

  return (
    <div className="max-w-md mx-auto">
      <Card>
        <CardHeader>
          <CardTitle>New Service</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Service Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-service"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="image">Docker Image</Label>
              <Input
                id="image"
                value={image}
                onChange={(e) => setImage(e.target.value)}
                placeholder="nginx:latest"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ports">Container Ports</Label>
              <Input
                id="ports"
                value={ports}
                onChange={(e) => setPorts(e.target.value)}
                placeholder="80, 443"
                required
              />
              <p className="text-xs text-muted-foreground">
                Comma-separated list of ports
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => router.back()}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={isLoading || !name.trim() || !image.trim()}
              >
                {isLoading ? "Creating..." : "Create Service"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
