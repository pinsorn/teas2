import type { ReactNode } from 'react';
import './paper.css';

/** Root of a printed document. `data-paper-ready` appears once measurement and pagination are done (specs and e2e wait for it). */
export function Paper({ ready, children }: { ready: boolean; children: ReactNode }) {
  return <div className="paper-root" data-paper-ready={ready ? 'true' : undefined}>{children}</div>;
}

/** One A4 sheet (794 x 1123 px; print CSS pins it to the physical page). A stamp, when given, repeats on every sheet. */
export function PaperPage({ children, stamp }: { children: ReactNode; stamp?: { label: string; note?: string } }) {
  return (
    <section className="paper-page" data-paper-page>
      {children}
      {stamp ? <div className="paper-void" data-paper-void><div><b>{stamp.label}</b>{stamp.note ? <span>{stamp.note}</span> : null}</div></div> : null}
    </section>
  );
}
