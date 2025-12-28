"use client";

import { useState, useEffect, memo } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Key, Plus, X, Eye, EyeOff } from "lucide-react";
import { listSecrets, createSecret, deleteSecret } from "@/actions/secrets";
import type { Service } from "./types";

type Secret = {
  id: string;
  key: string;
  createdAt: Date | null;
};

export const SecretsSection = memo(function SecretsSection({
  service,
  onUpdate,
}: {
  service: Service;
  onUpdate: () => void;
}) {
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [showValue, setShowValue] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    listSecrets(service.id)
      .then(setSecrets)
      .finally(() => setIsLoading(false));
  }, [service.id]);

  const keyRegex = /^[A-Z_][A-Z0-9_]*$/;
  const isValidKey = newKey.trim() && keyRegex.test(newKey.trim());
  const canAdd = isValidKey && newValue.trim();

  const handleAdd = async () => {
    if (!canAdd) return;
    setIsSaving(true);
    try {
      await createSecret(service.id, newKey.trim(), newValue);
      const updated = await listSecrets(service.id);
      setSecrets(updated);
      setNewKey("");
      setNewValue("");
      onUpdate();
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (secretId: string) => {
    await deleteSecret(secretId);
    setSecrets(secrets.filter((s) => s.id !== secretId));
    onUpdate();
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Key className="h-4 w-4" />
          Environment Variables
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading...</div>
        ) : secrets.length > 0 ? (
          <div className="space-y-2">
            {secrets.map((secret) => (
              <div
                key={secret.id}
                className="flex items-center justify-between px-3 py-2 rounded-md text-sm bg-muted"
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono font-medium">{secret.key}</span>
                  <span className="text-muted-foreground">= ••••••••</span>
                </div>
                <button
                  type="button"
                  onClick={() => handleDelete(secret.id)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">No environment variables configured</div>
        )}

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Input
              type="text"
              placeholder="KEY_NAME"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value.toUpperCase())}
              className="flex-1 font-mono"
            />
            <span className="text-muted-foreground">=</span>
            <div className="flex-1 relative">
              <Input
                type={showValue ? "text" : "password"}
                placeholder="value"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowValue(!showValue)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showValue ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <Button size="sm" variant="outline" onClick={handleAdd} disabled={!canAdd || isSaving}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          {newKey && !isValidKey && (
            <p className="text-xs text-destructive">
              Key must start with a letter or underscore, contain only uppercase letters, numbers, and underscores
            </p>
          )}
        </div>

        {secrets.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Changes take effect on next deployment
          </p>
        )}
      </CardContent>
    </Card>
  );
});
