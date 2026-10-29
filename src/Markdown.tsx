/** Markdown with no raw HTML, executable URLs, or remote tracking images. */
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
export default function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          img: ({ alt }) => <span className="muted">{alt || 'Image'}</span>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
