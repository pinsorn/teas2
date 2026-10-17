'use client';
import type { PaperModel } from '@/domain/types';
import { Paper } from './Paper';
import { CertificateSheets } from './WhtCertificatePaper';

/** PY3 ruling 8: the annual 50 ทวิ for the employees - one certificate (two copies) per employee, on the SAME RD-approved layout as the TX4 certificate (`CertificateSheets`; not a fork). Every model is the server's, built from the finalized ภ.ง.ด.1ก rows:
 *  income 40(1), the PIT withheld, the SSO the employee paid in the funds field, the ภ.ง.ด.1ก box ticked. Nothing is computed here. */
export function EmployeeWhtCertificatePaper({ models }: { models: PaperModel[] }) {
  return (
    <Paper ready>
      {models.filter((m) => m.certificate).map((m) => <CertificateSheets key={m.number} model={m} />)}
    </Paper>
  );
}
