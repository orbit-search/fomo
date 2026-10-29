/** Load Markdown parsing when there is content, keeping the empty workspace lightweight. */
import { lazy, Suspense } from 'react';
const Markdown = lazy(() => import('./Markdown'));
export default function Content({ text }: { text: string }) {
  return (
    <Suspense fallback={<p className="markdown">{text}</p>}>
      <Markdown text={text} />
    </Suspense>
  );
}
