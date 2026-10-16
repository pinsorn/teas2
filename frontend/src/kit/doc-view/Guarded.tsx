'use client';
import { useId, type ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** A disabled action keeps its place and says why (aria-describedby + tooltip), never just goes grey. */
export function Guarded({ why, children }: { why?: string; children: (p: { disabled: boolean; 'aria-describedby'?: string }) => ReactNode }) {
  const id = useId();
  if (!why) return <>{children({ disabled: false })}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild><span tabIndex={0} className="inline-flex">{children({ disabled: true, 'aria-describedby': id })}<span id={id} className="sr-only">{why}</span></span></TooltipTrigger>
      <TooltipContent>{why}</TooltipContent>
    </Tooltip>
  );
}
