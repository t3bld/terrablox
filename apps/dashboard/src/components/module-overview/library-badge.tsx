import { Badge } from "@terrablox/ui/badge";
import { cn } from "@terrablox/ui/lib/utils";
import { Library } from "lucide-react";

interface LibraryBadgeProps {
  library: { id: string; name: string } | null | undefined;
  className?: string;
}

/**
 * Which managed library a module comes from — Terrablox, Porsche, … Renders
 * nothing for the user's own imports, which keep their current look.
 */
export function LibraryBadge({ library, className }: LibraryBadgeProps) {
  if (!library) return null;

  return (
    <Badge
      className={cn("h-6 gap-1.5 px-2", className)}
      title={`${library.name} module library`}
      variant="outline"
    >
      <Library aria-hidden="true" className="h-3.5 w-3.5" />
      {library.name}
    </Badge>
  );
}
