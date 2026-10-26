'use client';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { PAPERS } from '@/kit/paper/registry';
import { LoadingState } from '@/kit/states/LoadingState';
import { authApi } from '@/records/auth';

/** SP1c HC3: a document by its public link. NO shell, no session, no company data beyond the paper. The paper is the server-built one (the same builders as every print); an unknown, revoked or no-longer-issued link is ONE plain page. */
export default function PublicDocumentPage() {
  const t = useTranslations('auth.publicLink');
  const { token } = useParams<{ token: string }>();
  const q = useQuery({ queryKey: ['public', token], queryFn: () => authApi.publicPaper(token), retry: false, staleTime: 0 });
  const Paper = q.data ? PAPERS[q.data.type] : undefined;
  return (
    <main id="content" className="mx-auto max-w-5xl p-3 md:p-6">
      <meta name="robots" content="noindex, nofollow" />
      <meta name="referrer" content="no-referrer" />
      {q.isPending ? <LoadingState rows={3} /> : q.data && Paper ? (
        <>
          <title>{`${q.data.paper.titleTh} ${q.data.paper.number}`}</title>
          <h1 className="sr-only">{q.data.paper.titleTh} {q.data.paper.number}</h1>
          <Paper model={q.data.paper} />
        </>
      ) : (
        <div className="mx-auto grid max-w-md gap-2 py-24 text-center" data-screen-state="not-found">
          <title>{t('invalidTitle')}</title>
          <h1 className="text-title font-semibold">{t('invalidTitle')}</h1>
          <p className="text-body text-muted-foreground">{t('invalidBody')}</p>
        </div>
      )}
    </main>
  );
}
