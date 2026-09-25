import { EmptyState, Page, PageHeader } from '@d3cloud/ui';

/** A placeholder until the mail store lands (PST-P-3): the shell needs somewhere to arrive. */
export function Mail() {
  return (
    <Page>
      <PageHeader title="Mail" />
      <EmptyState kind="empty" heading="No mail here yet" size="page" headingLevel={2}>
        Postroom is not receiving mail yet. Your inbox appears here once delivery is switched on.
      </EmptyState>
    </Page>
  );
}
