// PST-T-17.1 (PST-REQ-194): the head row of an admin card on the canvas — its h2 and a muted
// summary on the left, a link or a legend on the right, a hairline under it. It is the card's
// `pr-table-toolbar` row (admin.css), so a list card and a titled card share one grammar.
import type { ReactNode } from 'react';

export function CardHead({
  id,
  title,
  meta,
  description,
  end,
  level = 2,
}: {
  id: string;
  title: string;
  /** A short summary beside the title: "8 healthy · 1 not checked". */
  meta?: string | null | undefined;
  /** A sentence under the title, when the card needs one. */
  description?: string | undefined;
  end?: ReactNode;
  level?: 2 | 3;
}) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <div className="pr-table-toolbar pr-card-head">
      <div className="pr-card-head__lead">
        <div className="pr-card-head__line">
          <Heading id={id} className="pr-card-head__title">
            {title}
          </Heading>
          {meta === undefined || meta === null ? null : <span className="pr-card-head__meta">{meta}</span>}
        </div>
        {description === undefined ? null : <p className="pr-card-head__desc">{description}</p>}
      </div>
      {end === undefined ? null : <div className="pr-table-toolbar__end">{end}</div>}
    </div>
  );
}
