import { useMemo } from 'react';
import type { ExternalProposalController } from '../../agent/useExternalAgentBridge';
import { useT } from '../../i18n/locale';
import { theme } from '../../theme';
import { ProposalCard } from './ProposalCard';

export function ExternalProposalCard({ external, stale, preview, onPreview }: {
  external: ExternalProposalController;
  stale: boolean;
  preview: boolean;
  onPreview: (selected: ReadonlySet<number> | null) => void;
}) {
  const t = useT();
  const proposal = useMemo(() => external.proposal
    ? { ...external.proposal, title: `${external.proposal.title} ${t('编辑提案')}` }
    : null, [external.proposal, t]);

  return (
    <>
      {external.error && (
        <div role="alert" style={{ margin: '10px 0', color: theme.danger, fontSize: 12 }}>
          {t('外部 Agent：{message}', { message: external.error })}
        </div>
      )}
      {proposal && (
        <ProposalCard
          proposal={proposal}
          onApply={external.applyProposal}
          onReject={external.rejectProposal}
          stale={stale}
          preview={preview}
          onForceApply={external.forceApplyProposal}
          onPreview={onPreview}
        />
      )}
    </>
  );
}
