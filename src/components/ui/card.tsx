import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Radius, border weight and surface colour come from the theme tokens via the
 * `.surface-card` class (see globals.css). Deliberately no shadow: separation
 * in this theme is done by the rule and the whitespace around it.
 */
function Card({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("surface-card", className)} {...props} />;
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col space-y-1.5 p-[var(--pad-card)] pb-[calc(var(--pad-card)*0.6)]", className)} {...props} />;
}

function CardTitle({ className, children, ...props }: React.ComponentProps<"h3">) {
  return (
    <h3
      className={cn("text-xl font-semibold leading-none", className)}
      {...props}
    >
      {children}
    </h3>
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("p-[var(--pad-card)] pt-0", className)} {...props} />;
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex items-center p-[var(--pad-card)] pt-0", className)} {...props} />;
}

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent };
