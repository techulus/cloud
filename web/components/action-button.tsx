"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

interface ActionButtonProps {
  action: () => Promise<unknown>;
  label: string;
  loadingLabel: string;
  variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
  size?: "default" | "sm" | "lg" | "icon";
  onComplete?: () => void;
}

export function ActionButton({
  action,
  label,
  loadingLabel,
  variant = "default",
  size = "sm",
  onComplete,
}: ActionButtonProps) {
  const [isLoading, setIsLoading] = useState(false);

  const handleClick = async () => {
    setIsLoading(true);
    try {
      await action();
      onComplete?.();
    } catch (error) {
      console.error("Action failed:", error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Button
      onClick={handleClick}
      disabled={isLoading}
      variant={variant}
      size={size}
    >
      {isLoading ? loadingLabel : label}
    </Button>
  );
}
